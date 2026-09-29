import { describe, expect, test } from "bun:test";
import type { DesktopDiagnosticsSnapshot } from "../src/desktop-runtime";
import { buildDesktopDiagnosticsReport } from "../src/desktop-support-report";

const snapshot: DesktopDiagnosticsSnapshot = {
  reportVersion: 1,
  generatedAtMs: Date.UTC(2026, 8, 1, 0, 0, 0),
  appVersion: "1.0.1",
  platform: "windows",
  architecture: "x86_64",
  runtime: {
    state: "degraded",
    endpoint: {
      host: "127.0.0.1",
      port: 10_100,
      pid: 9_136,
      ready: true,
    },
  },
  logPath: ".remodex/desktop-runtime.log",
  logExists: true,
  sourceBytes: 4_096,
  includedBytes: 64,
  truncated: true,
  log: "[desktop error] Apply Changes Failed\n[redacted sensitive data]",
};

describe("desktop support reports", () => {
  test("formats the exact redacted support artifact", () => {
    const report = buildDesktopDiagnosticsReport(snapshot);
    expect(report).toContain("Generated: 2026-09-01T00:00:00.000Z");
    expect(report).toContain("Platform: windows/x86_64");
    expect(report).toContain("Runtime endpoint: 127.0.0.1:10100, pid 9136, ready=yes");
    expect(report).toContain("Log source: .remodex/desktop-runtime.log");
    expect(report).toContain("[redacted sensitive data]");
    expect(report).not.toContain("API_KEY=");
  });

});
