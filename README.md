# RUT956 DLMS Server

A Node.js/TypeScript TLS server for testing a RUT956 router connection to a DLMS/COSEM meter. It currently has two server modes:

- **TLS-PSK** (`src/server-psk.ts`): authenticates the router by its TLS-PSK identity, then handles a DLMS/HDLC session and reads the active imported-energy register (`1-0:1.8.0*255`).
- **Mutual TLS (mTLS)** (`src/server-cert.ts`): verifies a router client certificate and its IMEI against an allowlist, then performs the same DLMS read.

This project is an integration/test server. Configure and test it on a trusted network before using it with a live meter.

## Requirements

- Node.js 22 or later and npm
- For container use: Docker with the Compose plugin
- A router configured to connect to the server using the selected TLS mode
- A DLMS meter reachable through the router

Install dependencies from the repository root:

```sh
npm ci
```

## TLS-PSK mode

PSKs are stored in [`src/psk-store.ts`](src/psk-store.ts), keyed by the router's TLS identity. Add one identity/key pair for each router. Keys must be even-length hexadecimal strings. The example identity `868711065392659` has an empty key initially; replace it with the router's actual key before starting the server. The server fails at startup while any configured store entry has an empty or invalid key.

For example, the store can contain multiple router records:

```ts
export const psks = new Map<string, string>([
	["868711065392659", "replace-with-first-router-key-hex"],
	["868711065392660", "replace-with-second-router-key-hex"],
]);
```

Use the actual hexadecimal key bytes rather than the explanatory strings shown above. A router identity must also be in the `allowedRouters` map in [`src/allowed-routers.ts`](src/allowed-routers.ts); the PSK store performs key lookup, while that map authorizes identities and associates them with meters.

This map is an in-memory development store in a tracked source file, not a secure database. Real keys added here will be plaintext in the repository and its Git history. Restrict repository access, and use a secret manager or protected database for production credentials.

Start the DLMS server:

```sh
npm run dev
```

The server listens on `0.0.0.0:8443` by default. Override the bind address or port with `HOST` and `PORT`:

```sh
HOST=0.0.0.0 PORT=8443 npm run dev
```

The current PSK implementation uses DLMS client address `1`, server address `22836`, low-level security (authentication level `1`), and password `00000000`. Those DLMS values are currently fixed in `src/server-psk.ts`; setting `DLMS_PASSWORD` does not change the password used to create the client in this mode.

### Echo transport test

To test only the TLS-PSK transport without DLMS handling, run the echo server instead. Unlike the DLMS server, this standalone test still takes one PSK from environment variables:

```sh
PSK_HEX=0123456789abcdef0123456789abcdef npm exec tsx src/server-echo-test.ts
```

The test expects the identity `rut956_test_001` by default. Set `PSK_IDENTITY` to override it. This server echoes received bytes and is not the DLMS server.

## Mutual TLS mode

Start the certificate-authenticated DLMS server with:

```sh
npm run start-cert
```

It listens on port `8443`. The server expects these files under `certs/`:

- `server.key` and `server.crt` for the server identity
- `ca.crt` to verify router client certificates

The router must present a client certificate whose common name (CN) is a 15-digit IMEI. That IMEI must be listed in `src/allowed-routers.ts`. The server certificate must also be valid for the address the router uses to connect.

Certificate and private-key files are ignored by Git, so a fresh clone will not include them. Provision them locally from your trusted CA or certificate-management process. Do not commit private keys. The repository may contain local development certificates, but those should not be treated as production credentials.

The mTLS server supports these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DLMS_CLIENT_ADDRESS` | `1` | DLMS client address |
| `DLMS_SERVER_ADDRESS` | `22836` | DLMS server address |
| `DLMS_AUTHENTICATION` | `1` | DLMS authentication level |
| `DLMS_PASSWORD` | `00000000` | DLMS low-level security password |

## Docker Compose

Compose provides separate profiles for each server mode. Run only one at a time because both bind host port `8443`.

For TLS-PSK:

```sh
docker compose --profile psk up --build
```

For mTLS, first provision the required certificate files in `certs/`, then run:

```sh
docker compose --profile cert up --build
```

The Compose mTLS profile defaults `DLMS_PASSWORD` to `00000000`; override it in the shell or an untracked `.env` file when needed. Stop either server with `Ctrl+C`.

## Development checks and diagnostic scripts

Run the TypeScript type check:

```sh
npm run typecheck
```

`src/check-address.ts` prints sample DLMS SNRM frames for candidate server addresses:

```sh
npm exec tsx src/check-address.ts
```

`src/snrm-test.ts` is an experimental TLS/SNRM test server. It requires `TLS_PSK_IDENTITY` and `TLS_PSK_HEX`; the server bind address and port can be set with `RUT_HOST` and `RUT_PORT`:

```sh
RUT_HOST=0.0.0.0 RUT_PORT=8443 \
TLS_PSK_IDENTITY=your-router-identity \
TLS_PSK_HEX=0123456789abcdef0123456789abcdef \
npm exec tsx src/snrm-test.ts
```

## Troubleshooting

- **PSK handshake fails:** confirm that the router's TLS identity has a matching hexadecimal key in `src/psk-store.ts` and is in `allowedRouters`.
- **mTLS rejects the router:** check the certificate chain, validity dates, 15-digit CN, and matching allowlist entry.
- **DLMS association or read fails:** verify the DLMS addresses, authentication level, password, meter configuration, and that the router can reach the meter.
- **Port 8443 is busy:** stop the other server or change `PORT` in TLS-PSK mode. The mTLS implementation currently binds port `8443` directly.

The package's `start` script references `src/server.ts`, which is not present in this repository. Use `npm run dev` for TLS-PSK or `npm run start-cert` for mTLS.