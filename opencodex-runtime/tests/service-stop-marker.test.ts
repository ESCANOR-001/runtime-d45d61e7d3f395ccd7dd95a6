import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearServiceStopRequest,
  isServiceStopRequested,
  requestServiceStop,
  serviceStopMarkerPath,
} from "../src/lib/service-stop-marker";

describe("Windows service stop marker", () => {
  test("uses one owner-local marker path", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stop-marker-"));
    try {
      expect(serviceStopMarkerPath(home)).toBe(join(home, "service-stop-requested"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("records and clears an intentional stop on Windows", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-stop-marker-"));
    try {
      // The marker is deliberately Windows-only. Keep this test green on the
      // other CI hosts while native Windows runs the real filesystem behavior.
      if (process.platform !== "win32") return;

      const marker = serviceStopMarkerPath(home);
      expect(isServiceStopRequested(home)).toBe(false);
      requestServiceStop(home);
      expect(existsSync(marker)).toBe(true);
      expect(isServiceStopRequested(home)).toBe(true);
      expect(readFileSync(marker, "utf8")).toMatch(/^\d+\n$/);

      clearServiceStopRequest(home);
      expect(existsSync(marker)).toBe(false);
      expect(isServiceStopRequested(home)).toBe(false);
      // Clearing an already-cleared marker is intentionally idempotent.
      clearServiceStopRequest(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
