
import tls from "node:tls";
import {
  DlmsClient,
  InterfaceType,
} from "@bubblyworld/gurux-dlms-ts";

const HOST = process.env.RUT_HOST ?? "0.0.0.0";
const PORT = Number(process.env.RUT_PORT ?? 8443);

// Set these environment variables to match your existing TLS server.
const PSK_IDENTITY = process.env.TLS_PSK_IDENTITY!;
const PSK_HEX = process.env.TLS_PSK_HEX!;

if (!PSK_IDENTITY || !PSK_HEX) {
  throw new Error("Set TLS_PSK_IDENTITY and TLS_PSK_HEX");
}

const client = await DlmsClient.create({
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

const server = tls.createServer(
  {
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    ciphers: "PSK-AES128-GCM-SHA256",
    pskCallback: (identity) => {
      if (identity !== PSK_IDENTITY) return null;
      return Buffer.from(PSK_HEX, "hex");
    },
  },
  (socket) => {
    console.log("TLS client connected:", socket.remoteAddress);

    let finished = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.removeAllListeners("data");
      client.free();
    };

    socket.on("error", (err) => {
      console.error("Socket error:", err.message);
      cleanup();
    });

    socket.on("close", () => {
      console.log("TLS connection closed");
      cleanup();
    });

    socket.on("data", (data) => {
      if (finished) {
        console.log("Additional bytes:", data.toString("hex"));
        return;
      }

      finished = true;
      if (timeout) clearTimeout(timeout);

      const response = Buffer.from(data);
      console.log("Received bytes:", response.toString("hex").toUpperCase());

      try {
        client.parseUaResponse(new Uint8Array(response));
        console.log("UA parsed successfully — HDLC link established");
      } catch (err) {
        console.error(
          "UA parsing failed:",
          err instanceof Error ? err.message : err,
        );
      }

      socket.end();
    });

    const snrmFrames = client.snrmRequest();
    console.log("Sending SNRM:", Buffer.from(snrmFrames[0]).toString("hex").toUpperCase());
    socket.write(Buffer.from(snrmFrames[0]));

    timeout = setTimeout(() => {
      if (!finished) {
        console.error("Timed out waiting for a UA response");
        socket.destroy();
      }
    }, 5000);
  },
);

server.listen(PORT, HOST, () => {
  console.log(`DLMS SNRM test listening on ${HOST}:${PORT}`);
});
