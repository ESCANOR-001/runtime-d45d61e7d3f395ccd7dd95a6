/** Only private IPv4 networks; exclude loopback, public, and link-local addresses. */
export function isPrivateLanIpv4(address: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const octets = address.split(".").map(Number);
  if (octets.some(value => value > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168);
}

export function isAndroidRemoteLocalUrl(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "http:" && !url.username && !url.password && isPrivateLanIpv4(url.hostname);
  } catch { return false; }
}
