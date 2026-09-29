import { homedir } from "node:os";
import { join } from "node:path";

process.env.REMODEX_CONNECT_ONLY = "1";
process.env.OPENCODEX_HOME ||= join(homedir(), ".remodex-connect");

const argumentsWithoutProof = process.argv.slice(2).filter(argument => !argument.startsWith("--ocx-internal-launch-proof="));
const command = argumentsWithoutProof[0];
const commands = new Set(["onboard", "start", "stop", "restart", "status", "ready", "service", "doctor", "version", "--version", "-v"]);

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log("Remodex Connect — native ChatGPT / Codex remote access\n\nCommands: onboard, start, stop, restart, status, ready, service, doctor, version\n\nExisting Codex settings are read-only. Provider setup, injection, and config migration are not supported.");
} else if (!commands.has(command)) {
  console.error(`'${command}' is not available in Remodex Connect. Existing Codex settings were not changed.`);
  process.exitCode = 64;
} else {
  await import("./index");
}
