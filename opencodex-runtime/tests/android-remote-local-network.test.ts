import { expect, test } from "bun:test";
import { androidRemotePeerAllowed, androidRemotePairingUrls } from "../src/android-remote/gateway";
import { isAndroidRemoteLocalUrl } from "../src/android-remote/local-network";

test("accepts only private local addresses and loopback tunnel connections", () => {
  for (const address of ["192.168.1.5", "10.0.1.2", "172.16.0.5", "172.31.255.4", "127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    expect(androidRemotePeerAllowed(address)).toBe(true);
  }
  for (const address of [undefined, "", "8.8.8.8", "172.32.0.1", "169.254.1.2", "10..1.2", "10.256.1.2", "2001:4860:4860::8888"]) {
    expect(androidRemotePeerAllowed(address)).toBe(false);
  }
});

test("never treats a loopback, public, or credential-bearing URL as phone Wi-Fi readiness", () => {
  expect(isAndroidRemoteLocalUrl("http://192.168.1.3:10105")).toBe(true);
  for (const url of ["http://127.0.0.1:10105", "http://localhost:10105", "https://example.com", "http://8.8.8.8", "http://user:pass@192.168.1.2", "invalid"]) {
    expect(isAndroidRemoteLocalUrl(url)).toBe(false);
  }
  expect(androidRemotePairingUrls(10105, {})).toEqual([]);
});
