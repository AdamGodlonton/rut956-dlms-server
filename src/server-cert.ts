import tls from "node:tls";
import fs from "node:fs";
import type { TLSSocket } from "node:tls";
import { DlmsClient, InterfaceType, Register } from "@bubblyworld/gurux-dlms-ts";
import { allowedRouters } from "./allowed-routers.js";

const CLIENT_ADDRESS = Number(process.env.DLMS_CLIENT_ADDRESS ?? 1);
const SERVER_ADDRESS = Number(process.env.DLMS_SERVER_ADDRESS ?? 22836);
const AUTHENTICATION = Number(process.env.DLMS_AUTHENTICATION ?? 1);
const DLMS_PASSWORD = process.env.DLMS_PASSWORD ?? "00000000";

function sendAndReceive(
  socket: TLSSocket,
  frames: Uint8Array[],
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error("Socket is already closed."));
      return;
    }

    const chunks: Buffer[] = [];
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      if (drainTimer) clearTimeout(drainTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const finish = (error?: Error, data?: Uint8Array) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(data!);
    };

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => finish(undefined, Buffer.concat(chunks)), 200);
    };

    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Socket closed while awaiting a DLMS response."));

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    timeoutTimer = setTimeout(() => finish(new Error("Timed out waiting for a DLMS response.")), 10_000);

    try {
      for (const frame of frames) socket.write(Buffer.from(frame));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function readAttribute(
  client: DlmsClient,
  socket: TLSSocket,
  object: Register,
  attribute: number,
): Promise<void> {
  let response = await sendAndReceive(socket, client.read(object.inner, attribute));
  let result = client.getData(response);

  while (result.moreData !== 0) {
    response = await sendAndReceive(socket, client.receiverReady(result.moreData));
    result = client.getData(response);
  }

  client.updateValue(object.inner, attribute, new Uint8Array(0));
}

async function runDlmsSession(socket: TLSSocket): Promise<void> {
  let client: DlmsClient | undefined;
  let register: Register | undefined;

  try {
    client = await DlmsClient.create({
      clientAddress: CLIENT_ADDRESS,
      serverAddress: SERVER_ADDRESS,
      password: DLMS_PASSWORD,
      interfaceType: InterfaceType.HDLC,
    });

    client.setInt("authentication", AUTHENTICATION);
    client.setInt("maxInfoTX", 512);
    client.setInt("maxInfoRX", 512);
    client.setInt("windowSizeTX", 1);
    client.setInt("windowSizeRX", 1);

    console.log("Sending DLMS SNRM...");
    client.parseUaResponse(await sendAndReceive(socket, client.snrmRequest()));
    console.log("HDLC link established.");

    console.log("Sending DLMS AARQ...");
    client.parseAareResponse(await sendAndReceive(socket, client.aarqRequest()));
    console.log("DLMS association established.");

    register = new Register(client.getModule(), "1-0:1.8.0*255");
    console.log("Reading active imported energy...");
    await readAttribute(client, socket, register, 2);
    await readAttribute(client, socket, register, 3);

    console.log("Register value:", register.scaledValue);
    console.log("Register scaler:", register.scaler);
    console.log("Register unit:", register.unit);
  } catch (error) {
    console.error("DLMS session failed:", error instanceof Error ? error.message : error);
  } finally {
    try {
      if (client && !socket.destroyed) {
        try {
          await sendAndReceive(socket, client.releaseRequest());
        } catch {
          // The peer may already have closed the association.
        }
        try {
          await sendAndReceive(socket, client.disconnectRequest());
        } catch {
          // Best-effort HDLC cleanup.
        }
      }
    } finally {
      register?.free();
      client?.free();
    }
  }
}

function handleConnection(socket: TLSSocket): void {
  const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;

  // 1. Check that TLS certificate verification succeeded.
  if (!socket.authorized) {
    console.error(
      `TLS certificate rejected from ${remoteAddress}:`,
      socket.authorizationError,
    );

    socket.destroy();
    return;
  }

  // 2. Extract the client certificate.
  const certificate = socket.getPeerCertificate();

  if (!certificate || !certificate.subject) {
    console.error(`No client certificate from ${remoteAddress}`);
    socket.destroy();
    return;
  }

  // 3. Extract the IMEI from the certificate's Common Name (CN).
  const rawCN = certificate.subject.CN;
  const imei = Array.isArray(rawCN) ? rawCN[0] : rawCN;

  if (typeof imei !== "string" || !/^\d{15}$/.test(imei)) {
    console.error(`Invalid IMEI CN from ${remoteAddress}:`, rawCN);
    socket.destroy();
    return;
  }

  // 4. Check the server-side allowlist.
  if (!allowedRouters.has(imei)) {
    console.error(`Unauthorised router IMEI: ${imei}`);
    socket.destroy();
    return;
  }

  // 5. The router is authenticated and authorised.
  console.log(`Authorised router IMEI: ${imei}`);
  console.log(`TLS connection established from ${remoteAddress}`);

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });

  socket.on("close", () => {
    console.log("Connection closed.");
  });

  void runDlmsSession(socket).finally(() => {
    if (!socket.destroyed) socket.end();
  });
}

const server = tls.createServer({
  key: fs.readFileSync("certs/server.key"),
  cert: fs.readFileSync("certs/server.crt"),

  // CA trusted for router client certificates
  ca: [fs.readFileSync("certs/ca.crt")],

  requestCert: true,
  rejectUnauthorized: true,

  // Keep compatibility with the router's TLS 1.2 setup
  minVersion: "TLSv1.2",
}, 
  handleConnection
);

server.listen(8443, "0.0.0.0", () => {
  console.log("mTLS server listening on port 8443");
});