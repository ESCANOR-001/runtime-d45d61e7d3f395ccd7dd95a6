type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : null;
}

/** Only explicit exec result envelopes establish a running process or exit. */
export function commandSessionOutput(payload: JsonRecord): {
  sessionId: string | null;
  exitCode: number | null;
  output: string;
} | null {
  const parts = Array.isArray(payload.output) ? payload.output.slice(0, 32) : [payload.output];
  const results = parts.flatMap(part => {
    const text = typeof part === "string" ? part : record(part)?.text;
    if (typeof text !== "string" || text.length > 256 * 1024) return [];
    try {
      const value = record(JSON.parse(text));
      if (!value || typeof value.output !== "string") return [];
      const sessionId = typeof value.session_id === "number" || typeof value.session_id === "string"
        ? String(value.session_id).slice(0, 128) : null;
      const exitCode = typeof value.exit_code === "number" && Number.isFinite(value.exit_code)
        ? value.exit_code : null;
      if (!sessionId && exitCode === null) return [];
      return [{ sessionId, exitCode, output: value.output.slice(-64 * 1024) }];
    } catch {
      return [];
    }
  });
  // A wrapper can execute several tools. Never assign an ambiguous result to
  // its guessed first command; canonical item events will resolve those.
  return results.length === 1 ? results[0]! : null;
}

export function commandPollSessionId(payload: JsonRecord): string | null {
  let args = record(payload.arguments);
  if (!args && typeof payload.arguments === "string" && payload.arguments.length <= 128 * 1024) {
    try { args = record(JSON.parse(payload.arguments)); } catch { /* Unknown arguments. */ }
  }
  if (typeof args?.session_id === "number" || typeof args?.session_id === "string") {
    return String(args.session_id).slice(0, 128);
  }
  const input = typeof payload.input === "string" && payload.input.length <= 128 * 1024 ? payload.input : "";
  const ids = [...input.matchAll(/\bsession_id\s*:\s*(?:["']([\w-]{1,128})["']|(\d+))/gu)]
    .map(match => match[1] ?? match[2]!);
  return ids.length === 1 ? ids[0]! : null;
}

/** Compare a saved shell argv with the command supplied to exec_command. */
export function savedCommandText(raw: unknown): string {
  const item = record(raw);
  const command = item?.command;
  if (typeof command === "string") return command.trim();
  if (!Array.isArray(command)) return "";
  if (command.length === 3 && typeof command[0] === "string"
    && /(?:^|[/\\])(?:bash|sh|zsh|dash|ksh)(?:\.exe)?$/iu.test(command[0])
    && /^-[a-z]*c[a-z]*$/u.test(String(command[1])) && typeof command[2] === "string") {
    return command[2].trim();
  }
  return command.filter(value => typeof value === "string").join(" ").trim();
}
