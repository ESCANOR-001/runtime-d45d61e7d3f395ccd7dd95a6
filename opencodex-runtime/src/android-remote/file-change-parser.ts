type JsonRecord = Record<string, unknown>;

export type AndroidRemoteFileChange = {
  path: string;
  kind: { type: "add" | "update" | "delete" };
  diff?: string;
};

const MAX_FILE_CHANGES = 64;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parsedArguments(payload: JsonRecord): JsonRecord {
  const direct = record(payload.arguments);
  if (direct) return direct;
  const encoded = stringValue(payload.arguments);
  if (!encoded) return {};
  try { return record(JSON.parse(encoded)) ?? {}; }
  catch { return {}; }
}

function decodedDoubleQuotedStrings(source: string): string[] {
  const decoded: string[] = [];
  const literals = /"((?:\\[\s\S]|[^"\\])*)"/gu;
  for (const match of source.matchAll(literals)) {
    const body = match[1];
    if (!body || !body.includes("*** ")) continue;
    try {
      const value = JSON.parse(`"${body}"`);
      if (typeof value === "string") decoded.push(value);
    } catch {
      // A malformed or non-JSON JavaScript string is ignored. The original
      // source remains a candidate and can still contain a literal patch.
    }
  }
  return decoded;
}

function patchSources(payload: JsonRecord): string[] {
  const input = stringValue(payload.input);
  const args = parsedArguments(payload);
  const sources = [stringValue(args.patch), input].filter(Boolean);
  if (input.includes("\\n") || input.includes('\\"')) {
    sources.push(...decodedDoubleQuotedStrings(input));
  }
  return sources;
}

function dedupeKey(path: string): string {
  // Windows treats drive-letter and network paths as case-insensitive. Keep
  // the first spelling for display, but do not count the same file twice.
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path) ? path.toLocaleLowerCase("en-US") : path;
}

function changesFromPatchSource(source: string): AndroidRemoteFileChange[] {
  const header = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gmu;
  const matches = [...source.matchAll(header)];
  const byPath = new Map<string, AndroidRemoteFileChange>();

  for (const [index, match] of matches.entries()) {
    const operation = match[1]?.toLocaleLowerCase("en-US");
    const path = match[2]?.trim();
    if (!path || !["add", "update", "delete"].includes(operation ?? "")) continue;

    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? source.length;
    const body = source
      .slice(bodyStart, bodyEnd)
      .replace(/^\*\*\* End Patch\s*$/gmu, "")
      .trim();
    const key = dedupeKey(path);
    const existing = byPath.get(key);
    const diff = [existing?.diff, body].filter(Boolean).join("\n");
    byPath.set(key, {
      path: existing?.path ?? path,
      kind: existing?.kind ?? { type: operation as "add" | "update" | "delete" },
      ...(diff ? { diff } : {}),
    });
  }

  return [...byPath.values()];
}

/** Reads file paths and the immediately available line diff from an apply_patch call. */
export function fileChangesFromToolCall(payload: JsonRecord): AndroidRemoteFileChange[] {
  const name = stringValue(payload.name);
  const input = stringValue(payload.input);
  if (name !== "apply_patch" && !(name === "exec" && /\btools\.apply_patch\s*\(/u.test(input))) {
    return [];
  }

  const changes: AndroidRemoteFileChange[] = [];
  const seen = new Set<string>();
  for (const source of patchSources(payload)) {
    for (const change of changesFromPatchSource(source)) {
      const key = dedupeKey(change.path);
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(change);
      if (changes.length >= MAX_FILE_CHANGES) return changes;
    }
  }
  return changes;
}
