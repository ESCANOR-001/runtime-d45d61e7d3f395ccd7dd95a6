import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/tray/windows-tray.ps1"), "utf8");

describe("Windows tray restart process hardening", () => {
  test("fails a pending action when tracked process state cannot be inspected", () => {
    expect(source).toContain("pending process result inspection failed");
    expect(source).toMatch(/catch\s*\{[\s\S]*?pending process result inspection failed[\s\S]*?\$commandFailed\s*=\s*\$true[\s\S]*?\}/);
  });

  test("tracked command failure takes precedence over observed target state", () => {
  const failureIndex = source.indexOf("if ($commandFailed) { Complete-PendingAction $false }");
  const reachedIndex = source.indexOf("elseif ($reached) { Complete-PendingAction $true }");

  expect(failureIndex).toBeGreaterThan(-1);
  expect(reachedIndex).toBeGreaterThan(failureIndex);
});

  test("does not silently swallow pending-process disposal failures during live operation", () => {
    const matches = source.match(/pending process dispose failed/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const emptyCatch = ["catch", "{", "}"].join(" ");
  expect(source).not.toContain(`try { $script:pendingProcess.Dispose() } ${emptyCatch}`);
  });

  test("tracks every parity-menu command through one exit-code-aware launcher", () => {
    expect(source).toContain('$pending = Start-OcxCommand $CommandArgs -TrackExit');
    expect(source).toContain('$script:pendingProcess = $pending');
    expect(source).toContain('-CommandArgs @("__tray-start")');
    expect(source).toContain('-CommandArgs @("stop")');
    expect(source).toContain('-CommandArgs @("sync")');
    expect(source).toContain('-CommandArgs @("__desktop-restart-codex")');
    expect(source).toContain('-CommandArgs @("__desktop-restart-client")');
    expect(source).toContain('-CommandArgs @("gui", "--update")');
    expect(source).not.toContain("__desktop-update");
  });
});
