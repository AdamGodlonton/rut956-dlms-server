
import tls from "node:tls";
import type { TLSSocket } from "node:tls";
import {
  DlmsClient,
  Register,
  InterfaceType,
} from "@bubblyworld/gurux-dlms-ts";
import { allowedRouters } from "./allowed-routers.js";
import { getPsk } from "./psk-store.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8443);

const CLIENT_ADDRESS = 1;
const SERVER_ADDRESS = 22836; // Combined logical + physical address
const AUTHENTICATION = 1;    // Low-level security (LLS)
const DLMS_PASSWORD = process.env.DLMS_PASSWORD ?? "00000000";

if (AUTHENTICATION === 1 && !DLMS_PASSWORD) {
  throw new Error(
    "DLMS_PASSWORD is required for low-level security (authentication 1).",
  );
}

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

      drainTimer = setTimeout(() => {
        finish(undefined, Buffer.concat(chunks));
      }, 200);
    };

    const onError = (error: Error) => finish(error);

    const onClose = () => {
      finish(new Error("Socket closed while awaiting a DLMS response."));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);

    timeoutTimer = setTimeout(() => {
      finish(new Error("Timed out waiting for a DLMS response."));
    }, 10_000);

    try {
      for (const frame of frames) {
        socket.write(Buffer.from(frame));
      }
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

async function readAttribute(
  client: DlmsClient,
  socket: TLSSocket,
  object: Register,
  attribute: number,
): Promise<void> {
  let response = await sendAndReceive(
    socket,
    client.read(object.inner, attribute),
  );

  let result = client.getData(response);

  while (result.moreData !== 0) {
    response = await sendAndReceive(
      socket,
      client.receiverReady(result.moreData),
    );
    result = client.getData(response);
  }

  // Let the library apply its decoded reply to the COSEM object.
  client.updateValue(object.inner, attribute, new Uint8Array(0));
}

async function runDlmsSession(socket: TLSSocket): Promise<void> {
  let client: DlmsClient | undefined;
  let register: Register | undefined;

  try {
    const options: {
      clientAddress: number;
      serverAddress: number;
      password?: string;
    } = {
      clientAddress: CLIENT_ADDRESS,
      serverAddress: SERVER_ADDRESS,
    };

    if (DLMS_PASSWORD) {
      options.password = DLMS_PASSWORD;
    }

    client = await DlmsClient.create({
        clientAddress: 1,
        serverAddress: 22836,
        password: "00000000",
        interfaceType: InterfaceType.HDLC,
    });

    client.setInt("authentication", 1);
    client.setInt("maxInfoTX", 512);
    client.setInt("maxInfoRX", 512);
    client.setInt("windowSizeTX", 1);
    client.setInt("windowSizeRX", 1);

    // If no password is configured, use the requested auth setting.
    client.setInt("authentication", AUTHENTICATION);

    console.log("Sending DLMS SNRM...");
    const ua = await sendAndReceive(socket, client.snrmRequest());
    client.parseUaResponse(ua);
    console.log("HDLC link established.");

    console.log("Sending DLMS AARQ...");
    const aare = await sendAndReceive(socket, client.aarqRequest());
    client.parseAareResponse(aare);
    console.log("DLMS association established.");

    // Active imported energy: OBIS 1-0:1.8.0*255.
    register = new Register(
      client.getModule(),
      "1-0:1.8.0*255",
    );

    console.log("Reading active imported energy...");
    await readAttribute(client, socket, register, 2);
    await readAttribute(client, socket, register, 3);

    console.log("Register value:", register.scaledValue);
    console.log("Register scaler:", register.scaler);
    console.log("Register unit:", register.unit);
  } catch (error) {
    console.error(
      "DLMS session failed:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    try {
      if (client && !socket.destroyed) {
        // Best-effort graceful DLMS/HDLC teardown.
        try {
          await sendAndReceive(socket, client.releaseRequest());
        } catch {
          // The meter may already have closed the association.
        }

        try {
          await sendAndReceive(socket, client.disconnectRequest());
        } catch {
          // Best-effort cleanup only.
        }
      }
    } finally {
      register?.free();
      client?.free();
    }
  }
}

const server = tls.createServer(
  {
    pskCallback(_socket, identity) {
      if (!allowedRouters.has(identity)) {
        console.warn("Rejected TLS-PSK identity:", identity);
        return null;
      }

      const psk = getPsk(identity);
      if (!psk) {
        console.warn("No TLS-PSK configured for identity:", identity);
        return null;
      }

      return psk;
    },
  },
  (socket) => {
    console.log(
      `TLS connection from ${socket.remoteAddress}:${socket.remotePort}`,
    );
    console.log("TLS protocol:", socket.getProtocol());
    console.log("TLS cipher:", socket.getCipher()?.name);

    void runDlmsSession(socket).finally(() => {
      if (!socket.destroyed) socket.end();
    });
  },
);

server.on("tlsClientError", (error) => {
  console.error("TLS handshake failed:", error.message);
});

server.listen(PORT, HOST, () => {
  console.log(`TLS-PSK server listening on ${HOST}:${PORT}`);
  console.log(`Allowed router identities: ${allowedRouters.size}`);
  console.log(`DLMS client address: ${CLIENT_ADDRESS}`);
  console.log(`DLMS server address: ${SERVER_ADDRESS}`);
  console.log(`DLMS authentication: ${AUTHENTICATION}`);
});
