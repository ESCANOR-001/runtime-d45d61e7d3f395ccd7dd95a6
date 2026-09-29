import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Explicit approval fixture for tests exercising authorized Codex writes. */
export function grantTestCodexConfigConsent(codexHome: string, remodexHome: string): void {
  mkdirSync(remodexHome, { recursive: true });
  const path = join(remodexHome, "config.json");
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  config.codexConfigWriteConsent = join(codexHome, "config.toml");
  writeFileSync(path, JSON.stringify(config));
}
