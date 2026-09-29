import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestSessionMeta } from "../src/codex/history-provider";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(contents: string): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "rmx-history-reader-"));
  directories.push(directory);
  const file = join(directory, "rollout.jsonl");
  fs.writeFileSync(file, contents);
  return file;
}
const metadata = (provider: string) => JSON.stringify({ type: "session_meta", payload: { id: "task", model_provider: provider } });

test("reads the latest metadata from the tail without loading earlier conversation text", () => {
  const file = fixture(metadata("old") + "\n" + ("x".repeat(1023) + "\n").repeat(4096) + metadata("new") + "\n");
  const wholeFile = spyOn(fs, "readFileSync");
  const chunks = spyOn(fs, "readSync");
  try {
    expect(readLatestSessionMeta(file)?.record.payload.model_provider).toBe("new");
    expect(wholeFile).not.toHaveBeenCalled();
    expect(chunks).toHaveBeenCalledTimes(1);
    expect(chunks.mock.calls[0]?.[3]).toBe(64 * 1024);
  } finally { chunks.mockRestore(); wholeFile.mockRestore(); }
});

test.each(["", "\n", "\r\n"])("handles a single metadata record and %j ending", ending => {
  expect(readLatestSessionMeta(fixture(metadata("native") + ending))?.record.payload.model_provider).toBe("native");
});

test("reassembles large UTF-8 metadata across chunk boundaries", () => {
  const instructions = "世界🙂".repeat(18000);
  const latest = JSON.stringify({ type: "session_meta", payload: { id: "task", instructions, model_provider: "new" } });
  const file = fixture(metadata("old") + "\n" + latest + "\r\n{\"type\":\"event_msg\"}\n");
  expect(readLatestSessionMeta(file)?.record.payload.instructions).toBe(instructions);
});

test("ignores incomplete trailing JSON and unrelated records", () => {
  const file = fixture(metadata("new") + '\n{"type":"event_msg","payload":{"text":"session_meta"}}\n{"type":"session_meta",');
  expect(readLatestSessionMeta(file)?.record.payload.model_provider).toBe("new");
});

test("returns null for empty or metadata-free files", () => {
  expect(readLatestSessionMeta(fixture(""))).toBeNull();
  expect(readLatestSessionMeta(fixture("\n{}\nnot-json\n"))).toBeNull();
});

test("bounds a simulated multi-GB file scan without allocating that file on disk", () => {
  const file = fixture(metadata("must-not-guess"));
  const stats = fs.statSync(file);
  const fakeSize = 2 ** 31;
  let bytesRead = 0;
  const size = spyOn(fs, "fstatSync").mockReturnValue({ ...stats, size: fakeSize } as fs.Stats);
  const reads = spyOn(fs, "readSync").mockImplementation(((
    _fd: number, buffer: Buffer, offset: number, length: number,
  ) => {
    buffer.fill(0x78, offset, offset + length);
    bytesRead += length;
    return length;
  }) as typeof fs.readSync);
  try {
    expect(readLatestSessionMeta(file)).toBeNull();
    expect(bytesRead).toBe(16 * 1024 * 1024);
    expect(reads.mock.calls.every(args => Number(args[3]) <= 64 * 1024)).toBe(true);
  } finally { reads.mockRestore(); size.mockRestore(); }
});

test("does not trust a short read after a concurrent file truncation", () => {
  const file = fixture(metadata("old") + "\n");
  const reads = spyOn(fs, "readSync").mockReturnValue(0);
  try { expect(readLatestSessionMeta(file)).toBeNull(); }
  finally { reads.mockRestore(); }
});
