import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeActivityReader } from "../src/connect/activity";

let home: string;
let path: string;
let now: number;
let reader: NativeActivityReader;
const at = "2026-09-23T10:00:00.000Z";
const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: at, payload }) + "\n";
const tokens = (input: number, output: number) => row("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 2 }, last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 2 } } });
const session = (provider = "openai", extra = {}) => row("session_meta", { id: "native-thread", model_provider: provider, ...extra }) + row("turn_context", { turn_id: "turn-1", model: "gpt-native" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "connect-activity-"));
  mkdirSync(join(home, "sessions"));
  path = join(home, "sessions", "session.jsonl");
  now = Date.parse(at);
  reader = new NativeActivityReader(() => home, () => now);
});

afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test("counts cumulative deltas once, follows appended events, and never exposes messages", async () => {
  writeFileSync(path, session() + row("event_msg", { type: "task_started", turn_id: "turn-1" }) + row("response_item", { text: "PRIVATE PROMPT" }) + tokens(10, 3) + tokens(10, 3));
  const first = await reader.read();
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0]).toMatchObject({ input: 10, output: 3, cached: 2, state: "running", measured: true });
  expect(JSON.stringify(first)).not.toContain("PRIVATE PROMPT");
  expect(JSON.stringify(first)).not.toContain(home);
  appendFileSync(path, tokens(15, 5) + row("event_msg", { type: "task_complete", turn_id: "turn-1" }));
  now += 5_000;
  const next = await reader.read();
  expect(next.rows[0]).toMatchObject({ input: 15, output: 5, state: "completed" });
  expect(next.usage[0]).toMatchObject({ turns: 1, input: 15, output: 5 });
});

test("ignores non-OpenAI sessions and preserves configuration bytes", async () => {
  const config = join(home, "config.toml");
  writeFileSync(config, 'model_provider="custom"\n');
  writeFileSync(join(home, "config.yml"), "provider: custom\n");
  const before = readFileSync(config);
  writeFileSync(path, session("anthropic") + tokens(20, 5));
  expect((await reader.read()).rows).toEqual([]);
  expect(readFileSync(config)).toEqual(before);
  expect(readFileSync(join(home, "config.yml"), "utf8")).toBe("provider: custom\n");
});

test("deduplicates copied session records and excludes inherited fork usage", async () => {
  writeFileSync(path, session() + tokens(10, 3));
  writeFileSync(join(home, "sessions", "duplicate.jsonl"), session() + tokens(10, 3));
  writeFileSync(join(home, "sessions", "fork.jsonl"), row("session_meta", { id: "fork", model_provider: "openai", forked_from_id: "native-thread" }) + row("turn_context", { turn_id: "new-turn", model: "gpt-native" }) + tokens(10, 3) + tokens(14, 5));
  const result = await reader.read();
  expect(result.usage[0]).toMatchObject({ turns: 2, input: 14, output: 5 });
});

test("keeps partial lines until completed, recovers from truncation, and reports invalid records", async () => {
  const event = tokens(10, 3);
  writeFileSync(path, session() + event.slice(0, 30));
  expect((await reader.read()).rows).toHaveLength(0);
  appendFileSync(path, event.slice(30) + "{bad json}\n");
  now += 5_000;
  expect((await reader.read()).diagnostics.skippedRecords).toBe(1);
  writeFileSync(path, session() + tokens(5, 1));
  now += 5_000;
  expect((await reader.read()).rows[0]).toMatchObject({ input: 5, output: 1 });
});

test("does not follow linked session files", async () => {
  const external = join(home, "external.jsonl");
  writeFileSync(external, session() + tokens(10, 3));
  symlinkSync(external, path);
  expect((await reader.read()).rows).toHaveLength(0);
});

test("reports a missing home rather than serving a successful empty history", async () => {
  reader = new NativeActivityReader(() => join(home, "missing"));
  expect((await reader.read()).diagnostics.missingHome).toBe(true);
});

test("does not attribute inherited cumulative totals to the first observed turn", async () => {
  writeFileSync(path, session() + row("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 1000000, output_tokens: 20000 }, last_token_usage: { input_tokens: 10, output_tokens: 2 } } }) + tokens(1000005, 20001));
  const result = await reader.read();
  expect(result.usage[0]).toMatchObject({ input: 15, output: 3 });
  expect(result.diagnostics.limited).toBe(true);
});

test("counts usage on event days rather than moving an entire turn to its completion day", async () => {
  writeFileSync(path, session() + tokens(10, 3) + tokens(15, 4).replaceAll("2026-09-23", "2026-09-24") + row("event_msg", { type: "task_complete", turn_id: "turn-1" }).replaceAll("2026-09-23", "2026-09-25"));
  const result = await reader.read();
  expect(result.usage).toMatchObject([{ day: "2026-09-24", input: 5, output: 1 }, { day: "2026-09-23", input: 10, output: 3 }]);
});

test("provider changes do not leak other-provider tokens into native usage", async () => {
  writeFileSync(path, session() + tokens(10, 3) + row("turn_context", { turn_id: "other", model_provider: "custom", model: "other-model" }) + tokens(1000, 200) + row("turn_context", { turn_id: "native-again", model_provider: "openai", model: "gpt-native" }) + tokens(1005, 201));
  const result = await reader.read();
  expect(result.usage[0]).toMatchObject({ input: 15, output: 4 });
  expect(JSON.stringify(result)).not.toContain("other-model");
});
