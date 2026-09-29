import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the default tunnel worker cannot open a console or change system DNS", () => {
  const source = readFileSync(new URL("../src/android-remote/cloudflare-tunnel.ts", import.meta.url), "utf8");
  expect(source).not.toContain("windowsHide: false");
  expect(source).not.toContain("Set-DnsClientServerAddress");
  expect(source).not.toContain("Start-Process");
  const defaults = source.slice(source.indexOf("const defaultDeps:"), source.indexOf("function stopped("));
  expect(defaults).toContain("windowsHide: true");
  expect(defaults).not.toContain("repairWindowsDns:");
  expect(defaults).not.toContain("flushDnsCache:");
});
