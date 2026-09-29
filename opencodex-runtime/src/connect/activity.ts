import { constants } from "node:fs";
import { open, opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { resolveCodexHomeDir } from "../codex/home";

export interface NativeActivityRow {
  id: string;
  thread: string;
  at: number;
  model: string;
  state: "running" | "completed" | "interrupted" | "unknown";
  input: number;
  output: number;
  cached: number;
  measured: boolean;
}

interface FileState {
  identity: string;
  mtime: number;
  offset: number;
  pending: string;
  discarding: boolean;
  decoder: StringDecoder;
  thread: string;
  provider: string;
  model: string;
  turn: string;
  cumulative: number[] | null;
  fork: boolean;
  rows: Map<string, NativeActivityRow>;
  usage: Map<string, { day: string; model: string; input: number; output: number; cached: number }>;
  limited: boolean;
}

export interface NativeActivitySnapshot {
  generatedAt: number;
  source: "native-codex";
  rows: NativeActivityRow[];
  usage: Array<{ day: string; model: string; turns: number; input: number; output: number; cached: number }>;
  diagnostics: {
    files: number;
    pendingFiles: number;
    skippedRecords: number;
    unreadableFiles: number;
    limited: boolean;
    missingHome: boolean;
    configReadOnly: true;
  };
}

const MAX_FILES = 200;
const MAX_ROWS_PER_FILE = 400;
const MAX_LINE = 256 * 1024;
const MAX_READ_PER_FILE = 4 * 1024 * 1024;
const opaque = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown, fallback = ""): string => typeof value === "string" ? value.slice(0, 160) : fallback;
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export class NativeActivityReader {
  private files = new Map<string, FileState>();
  private inflight: Promise<NativeActivitySnapshot> | null = null;
  private cached: NativeActivitySnapshot | null = null;
  private skippedRecords = 0;

  constructor(private readonly home: () => string = resolveCodexHomeDir, private readonly now = Date.now) {}

  read(): Promise<NativeActivitySnapshot> {
    if (this.inflight) return this.inflight;
    if (this.cached && this.now() - this.cached.generatedAt < 2_000) return Promise.resolve(this.cached);
    this.inflight = this.scan().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private consume(line: string, state: FileState): void {
    let row: Record<string, unknown>;
    try { row = record(JSON.parse(line)); } catch { this.skippedRecords++; return; }
    const payload = record(row.payload);
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (row.type === "session_meta") {
      state.thread = opaque(label(payload.id, state.thread));
      state.provider = label(payload.model_provider, "openai");
      state.fork = Boolean(payload.forked_from_id);
      return;
    }
    if (row.type === "turn_context") {
      state.model = label(payload.model, state.model);
      state.turn = label(payload.turn_id, state.turn);
      state.provider = label(payload.model_provider, state.provider);
      return;
    }
    if (row.type !== "event_msg" || !Number.isFinite(at)) return;
    const kind = payload.type;
    const usage = record(record(payload.info).total_token_usage);
    const totals = [count(usage.input_tokens), count(usage.output_tokens), count(usage.cached_input_tokens)];
    if (state.provider !== "openai") {
      if (kind === "token_count" && Object.keys(usage).length) state.cumulative = totals;
      return;
    }
    if (!["task_started", "task_complete", "turn_aborted", "token_count"].includes(String(kind))) return;
    state.turn = label(payload.turn_id, kind === "task_started" ? String(at) : state.turn || "unattributed");
    const id = opaque(`${state.thread}:${state.turn}`);
    const current = state.rows.get(id) ?? {
      id, thread: state.thread, at, model: state.model || "Codex", state: "unknown" as const,
      input: 0, output: 0, cached: 0, measured: false,
    };
    current.at = Math.max(current.at, at);
    current.model = state.model || current.model;
    if (kind === "task_started") current.state = "running";
    if (kind === "task_complete") current.state = "completed";
    if (kind === "turn_aborted") current.state = "interrupted";
    if (kind === "token_count") {
      if (!Object.keys(usage).length) return;
      const previous = state.cumulative;
      const last = record(record(payload.info).last_token_usage);
      const lastTotals = [count(last.input_tokens), count(last.output_tokens), count(last.cached_input_tokens)];
      const baseline = previous ?? totals;
      const reset = totals.some((value, index) => value < baseline[index]!);
      const delta = !previous
        ? state.fork ? [0, 0, 0] : lastTotals.map((value, index) => Math.min(value, totals[index]!))
        : reset ? lastTotals
        : totals.map((value, index) => value - baseline[index]!);
      if (!previous && !state.fork && totals.some((value, index) => value > lastTotals[index]!)) state.limited = true;
      state.cumulative = totals;
      if (delta.every(value => value === 0)) return;
      current.input += delta[0]!;
      current.output += delta[1]!;
      current.cached += Math.min(delta[2]!, delta[0]!);
      current.measured = true;
      const day = new Date(at).toISOString().slice(0, 10);
      const key = `${id}:${day}:${current.model}`;
      const bucket = state.usage.get(key) ?? { day, model: current.model, input: 0, output: 0, cached: 0 };
      bucket.input += delta[0]!;
      bucket.output += delta[1]!;
      bucket.cached += Math.min(delta[2]!, delta[0]!);
      state.usage.set(key, bucket);
      while (state.usage.size > MAX_ROWS_PER_FILE * 2) {
        state.usage.delete(state.usage.keys().next().value!);
        state.limited = true;
      }
    }
    state.rows.set(id, current);
    while (state.rows.size > MAX_ROWS_PER_FILE) {
      state.rows.delete(state.rows.keys().next().value!);
      state.limited = true;
    }
  }

  private async scan(): Promise<NativeActivitySnapshot> {
    const diagnostics = { files: 0, pendingFiles: 0, skippedRecords: 0, unreadableFiles: 0, limited: false, missingHome: false, configReadOnly: true as const };
    const candidates: Array<{ path: string; size: number; mtime: number; identity: string }> = [];
    let home: string;
    try {
      home = this.home();
      if (!(await lstat(home)).isDirectory()) throw new Error("Missing home");
    } catch {
      diagnostics.missingHome = true;
      this.files.clear();
      return this.cached = { generatedAt: this.now(), source: "native-codex", rows: [], usage: [], diagnostics };
    }
    const directories = [join(home, "sessions"), join(home, "archived_sessions")];
    let inspected = 0;
    while (directories.length && inspected < 10_000) {
      const directory = directories.shift()!;
      try {
        if ((await lstat(directory)).isSymbolicLink()) continue;
        for await (const entry of await opendir(directory)) {
          if (++inspected > 10_000) { diagnostics.limited = true; break; }
          const path = join(directory, entry.name);
          if (entry.isDirectory()) directories.push(path);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            candidates.push({ path, size: stat.size, mtime: stat.mtimeMs, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.unreadableFiles++;
      }
    }
    if (directories.length || candidates.length > MAX_FILES) diagnostics.limited = true;
    const selected = candidates.sort((left, right) => right.mtime - left.mtime).slice(0, MAX_FILES);
    const paths = new Set(selected.map(file => file.path));
    for (const path of this.files.keys()) if (!paths.has(path)) this.files.delete(path);
    let budget = 32 * 1024 * 1024;
    for (const file of selected) {
      let state = this.files.get(file.path);
      if (!state || state.identity !== file.identity || file.size < state.offset || (file.size === state.offset && file.mtime !== state.mtime)) {
        state = { identity: file.identity, mtime: file.mtime, offset: 0, pending: "", discarding: false, decoder: new StringDecoder("utf8"), thread: opaque(file.path), provider: "openai", model: "", turn: "", cumulative: null, fork: false, rows: new Map(), usage: new Map(), limited: false };
        this.files.set(file.path, state);
      }
      state.mtime = file.mtime;
      const size = Math.min(file.size - state.offset, MAX_READ_PER_FILE, budget);
      if (size > 0) {
        try {
          const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = await handle.stat();
            if (`${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== file.identity) throw new Error("Session changed");
            const buffer = Buffer.alloc(64 * 1024);
            let remaining = size;
            while (remaining > 0) {
              const result = await handle.read(buffer, 0, Math.min(buffer.length, remaining), state.offset);
              if (!result.bytesRead) break;
              state.offset += result.bytesRead;
              budget -= result.bytesRead;
              remaining -= result.bytesRead;
              const pieces = state.decoder.write(buffer.subarray(0, result.bytesRead)).split("\n");
              for (let index = 0; index < pieces.length; index++) {
                const complete = index < pieces.length - 1;
                if (!state.discarding) state.pending += pieces[index]!;
                if (state.pending.length > MAX_LINE) { state.pending = ""; state.discarding = true; this.skippedRecords++; }
                if (complete) {
                  if (!state.discarding && state.pending.trim()) this.consume(state.pending, state);
                  state.pending = "";
                  state.discarding = false;
                }
              }
            }
          } finally { await handle.close(); }
        } catch { diagnostics.unreadableFiles++; }
      }
      if (file.size > state.offset) diagnostics.pendingFiles++;
      if (state.limited) diagnostics.limited = true;
    }
    const rows = new Map<string, NativeActivityRow>();
    for (const file of this.files.values()) for (const row of file.rows.values()) {
      const previous = rows.get(row.id);
      if (!previous || previous.at < row.at || previous.input + previous.output < row.input + row.output) rows.set(row.id, row);
    }
    const usage = new Map<string, NativeActivitySnapshot["usage"][number]>();
    const buckets = new Map<string, FileState["usage"] extends Map<string, infer Bucket> ? Bucket : never>();
    for (const file of this.files.values()) for (const [key, bucket] of file.usage) {
      const previous = buckets.get(key);
      if (!previous || previous.input + previous.output < bucket.input + bucket.output) buckets.set(key, bucket);
    }
    for (const row of buckets.values()) {
      const key = `${row.day}:${row.model}`;
      const aggregate = usage.get(key) ?? { day: row.day, model: row.model, turns: 0, input: 0, output: 0, cached: 0 };
      aggregate.turns++;
      aggregate.input += row.input;
      aggregate.output += row.output;
      aggregate.cached += row.cached;
      usage.set(key, aggregate);
    }
    diagnostics.files = selected.length;
    diagnostics.skippedRecords = this.skippedRecords;
    return this.cached = {
      generatedAt: this.now(), source: "native-codex", diagnostics,
      rows: [...rows.values()].sort((left, right) => right.at - left.at).slice(0, 200),
      usage: [...usage.values()].sort((left, right) => right.day.localeCompare(left.day)),
    };
  }
}

export const nativeActivityReader = new NativeActivityReader();
