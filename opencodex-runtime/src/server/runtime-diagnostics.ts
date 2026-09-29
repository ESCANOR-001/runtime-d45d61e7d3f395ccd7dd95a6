import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { redactSecretString, redactUserPath } from "../lib/redact";
import { truncateRetainedUtf8 } from "../lib/admission";

const MAX_LOG_BYTES = 128 * 1024;

function readLogTail(directory: string, name: string) {
  let fd: number | undefined;
  let sourceBytes = 0;
  try {
    const path = join(directory, name);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Redirected log");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.ino !== before.ino || metadata.dev !== before.dev) {
      throw new Error("Log changed while opening");
    }
    sourceBytes = metadata.size;
    const start = Math.max(0, sourceBytes - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(Math.min(sourceBytes, MAX_LOG_BYTES));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let raw = buffer.subarray(0, count).toString("utf8");
    // Drop a partial first line so a truncated credential label cannot be lost.
    if (start > 0) raw = raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1) : "";
    let sensitiveBlock = false;
    const safe = raw.split("\n").map(line => {
      if (/\b(prompt|request[_ -]?body|messages|input|cookie|authorization|credentials)\b["']?\s*[=:]/i.test(line)) {
        sensitiveBlock = true;
        return "[Sensitive log entry redacted]";
      }
      // Serialized bodies can span lines. Resume only at a fresh timestamped
      // log entry, never at an arbitrary JSON property or continuation line.
      if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(line)) sensitiveBlock = false;
      if (sensitiveBlock) return "";
      return redactUserPath(redactSecretString(line))
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED EMAIL]")
        .replace(/\bocx_(?:session_|admin_|data_)?[A-Za-z0-9_-]+/g, "[REDACTED]");
    }).join("\n");
    return {
      sourceBytes, logExists: true,
      truncated: start > 0 || Buffer.byteLength(safe) > MAX_LOG_BYTES,
      log: truncateRetainedUtf8(safe, MAX_LOG_BYTES) || "[No readable log entries]",
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      sourceBytes, logExists: !missing, truncated: !missing,
      log: missing ? "[Log has not been created yet]" : "[Log unavailable or refused; other logs are still included]",
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readRuntimeDiagnostics() {
  const directory = getConfigDir();
  const names = ["service.log", "crash.log"] as const;
  const sources = names.map(name => ({ name, ...readLogTail(directory, name) }));
  const log = sources.map(source => `----- ${source.name} -----\n${source.log}`).join("\n\n");
  let appVersion = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    if (typeof pkg.version === "string") appVersion = pkg.version;
  } catch { /* A damaged package should not prevent downloading diagnostics. */ }
  return {
    reportVersion: 1,
    generatedAtMs: Date.now(), appVersion,
    platform: process.platform, architecture: process.arch,
    runtime: { state: "ready", endpoint: null },
    logPath: names.map(name => `${process.env.REMODEX_CONNECT_ONLY === "1" ? "[Connect profile]" : ".remodex"}/${name}`).join(", "),
    logExists: sources.some(source => source.logExists),
    sourceBytes: sources.reduce((total, source) => total + source.sourceBytes, 0),
    includedBytes: Buffer.byteLength(log),
    truncated: sources.some(source => source.truncated), log,
  };
}
