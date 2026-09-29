/** A non-semantic default label for a user-owned Android Remote hostname. */
export function createRandomRemoteSubdomain(cryptoImpl: Crypto = globalThis.crypto): string {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(5));
  return `rmx-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
}
