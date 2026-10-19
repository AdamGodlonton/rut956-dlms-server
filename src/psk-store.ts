export const psks = new Map<string, string>([
  // Replace the empty value with this router's TLS-PSK key in hexadecimal.
  ["868711065392659", "7bff64620aaebf7b42c8d972c739a7af"],
]);

export function getPsk(identity: string): Buffer | undefined {
  const keyHex = psks.get(identity);
  if (!keyHex) return undefined;

  if (!/^(?:[0-9a-fA-F]{2})+$/.test(keyHex)) {
    throw new Error(`PSK for identity "${identity}" must be valid hexadecimal.`);
  }

  return Buffer.from(keyHex, "hex");
}

for (const [identity, keyHex] of psks) {
  if (!keyHex) {
    throw new Error(`Configure a TLS-PSK key for identity "${identity}" in src/psk-store.ts.`);
  }

  if (!/^(?:[0-9a-fA-F]{2})+$/.test(keyHex)) {
    throw new Error(`PSK for identity "${identity}" must be valid hexadecimal.`);
  }
}