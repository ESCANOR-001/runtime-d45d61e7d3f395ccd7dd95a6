import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const script = resolve(import.meta.dir, "../scripts/privacy-scan.ts");
const notices = "experiments/rust-connect/THIRD_PARTY_NOTICES.txt";
const address = ["jpixton", "gmail.com"].join("@");
const credit = `Copyright (c) 2016 Joseph Birr-Pixton <${address}>`;

function scan(file: string, text: string) {
  const parent = resolve(tmpdir());
  const root = mkdtempSync(join(parent, "remodex-license-scan-"));
  try {
    for (const args of [["init", "--quiet"], ["config", "core.autocrlf", "false"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: root, windowsHide: true }).exitCode).toBe(0);
    }
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    expect(Bun.spawnSync(["git", "add", "--", file], { cwd: root, windowsHide: true }).exitCode).toBe(0);
    return Bun.spawnSync([process.execPath, script], { cwd: root, windowsHide: true });
  } finally {
    if (!root.startsWith(parent + sep) || !root.includes("remodex-license-scan-")) {
      throw new Error("Refusing cleanup outside the disposable test folder");
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("Rust license notices preserve the exact upstream copyright credits", () => {
  const credits = [
    `Copyright (C) Jonas Schievink <${["jonasschievink", "gmail.com"].join("@")}>`,
    `Copyright (c) 2016, Joseph Birr-Pixton <${address}>`,
    credit,
    `Copyright (c) 2023 Dirkjan Ochtman <${["dirkjan", "ochtman.nl"].join("@")}>`,
  ];
  expect(scan(notices, credits.join("\n")).exitCode).toBe(0);
});

test("license exception does not allow an unrelated email in a copyright line", () => {
  const unrelated = ["private", "unrelated.invalid"].join("@");
  expect(scan(notices, credit.replace(address, unrelated)).exitCode).toBe(1);
});

test("license credits are not exempted in other source files", () => {
  expect(scan("src/accidental-copy.ts", credit).exitCode).toBe(1);
});

test("license addresses outside the exact credit are still reported", () => {
  expect(scan(notices, `Contact: ${address}`).exitCode).toBe(1);
});

test("license file still detects credentials beside allowed copyright credits", () => {
  const token = ["ghp_", "a".repeat(36)].join("");
  const result = scan(notices, `${credit}\n${token}`);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("token-looking");
});
