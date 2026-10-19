
import tls from "node:tls";
import type { TLSSocket } from "node:tls";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8443);

const EXPECTED_IDENTITY =
  process.env.PSK_IDENTITY ?? "rut956_test_001";

const PSK_HEX = process.env.PSK_HEX;

if (!PSK_HEX || !/^(?:[0-9a-fA-F]{2})+$/.test(PSK_HEX)) {
  throw new Error(
    "Set PSK_HEX to your hexadecimal TLS-PSK key."
  );
}

const psk = Buffer.from(PSK_HEX, "hex");

function handleConnection(socket: TLSSocket): void {
  console.log(
    `TLS connected: ${socket.remoteAddress}:${socket.remotePort}`
  );

  console.log(`Negotiated protocol: ${socket.getProtocol()}`);
  console.log(`Negotiated cipher: ${socket.getCipher()?.name}`);

  socket.on("data", (data: Buffer) => {
    console.log(`RX ${data.length} bytes: ${data.toString("hex")}`);

    // Temporary transport test only.
    // Replace this echo with the Gurux DLMS request/response
    // handling in a later step.
    socket.write(data);
  });

  socket.on("end", () => {
    console.log("Peer ended its connection.");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });

  socket.on("close", () => {
    console.log("Connection closed.");
  });
}

const server = tls.createServer(
  {
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    ciphers: "PSK-AES128-GCM-SHA256",

    pskCallback(_socket, identity) {
      if (identity !== EXPECTED_IDENTITY) {
        console.warn(`Rejected PSK identity: ${identity}`);
        return null;
      }

      return psk;
    },
  },
  handleConnection
);

server.on("tlsClientError", (error) => {
  console.error("TLS handshake failed:", error.message);
});

server.listen(PORT, HOST, () => {
  console.log(`TLS-PSK mock server listening on ${HOST}:${PORT}`);
  console.log(`Expected PSK identity: ${EXPECTED_IDENTITY}`);
});
