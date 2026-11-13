import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { desktopTranscriptReference } from '../src/android-remote/upgrade-desktop-reference';
import { readDesktopExportHeader } from '../src/android-remote/upgrade-desktop-history';
const native = '11111111-1111-4111-8111-111111111111';

test('compressed Desktop history preserves identity and settings without rewriting the profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compressed-upgrade-'));
  try {
    await mkdir(join(root, 'sessions'));
    const path = join(root, 'sessions', 'saved.jsonl');
    const source = JSON.stringify({ type: 'session_meta', payload: { id: native } }) + '\n'
      + JSON.stringify({ type: 'turn_context', payload: { model: 'saved-model', effort: 'high', cwd: root } }) + '\n';
    const compressed = zstdCompressSync(Buffer.from(source));
    await writeFile(path + '.zst', compressed);
    const before = await desktopTranscriptReference(root, path, native);
    expect(before.relative).toBe('sessions/saved.jsonl');
    if (process.platform === 'win32') {
      expect(await desktopTranscriptReference(root, toNamespacedPath(path), native)).toEqual(before);
      expect(await desktopTranscriptReference(toNamespacedPath(root), path, native)).toEqual(before);
    }
    const client = { request: async () => ({ thread: { id: native, path, modelProvider: 'openai', cwd: root } }) };
    expect(await readDesktopExportHeader(client, native, root, async () => false)).toMatchObject({
      androidRemoteModel: 'saved-model', androidRemoteNativeEffort: 'high',
    });
    expect(await access(path).then(() => true, () => false)).toBe(false);
    expect(await readFile(path + '.zst')).toEqual(compressed);
    // Codex may materialize a compressed chat before its next turn. The logical
    // reference and identity hash remain valid when that representation changes.
    await writeFile(path, source);
    await writeFile(path + '.zst', 'obsolete compressed sibling');
    expect(await desktopTranscriptReference(root, path + '.zst', native)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['corrupt', 'wrong-identity', 'linked', 'truncated'] as const) {
  test(`compressed Desktop history refuses ${mode} input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'compressed-upgrade-invalid-'));
    try {
      await mkdir(join(root, 'sessions'));
      const path = join(root, 'sessions', 'saved.jsonl');
      const source = JSON.stringify({ type: 'session_meta', payload: { id: mode === 'wrong-identity' ? 'other' : native } }) + '\n'
        + JSON.stringify({ type: 'turn_context', payload: { model: 'saved-model', cwd: root } }) + '\n';
      const compressed = zstdCompressSync(Buffer.from(source));
      await writeFile(path + '.zst', mode === 'corrupt' ? Buffer.from('corrupt') : mode === 'truncated' ? compressed.subarray(0, compressed.length - 4) : compressed);
      if (mode === 'linked') await link(path + '.zst', join(root, 'alias'));
      const client = { request: async () => ({ thread: { id: native, path, modelProvider: 'openai', cwd: root } }) };
      await expect(readDesktopExportHeader(client, native, root, async () => false)).rejects.toThrow();
      expect(await access(path).then(() => true, () => false)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test.skipIf(process.platform === 'win32')('a dangling plain symlink cannot select its compressed sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compressed-upgrade-symlink-'));
  try {
    await mkdir(join(root, 'sessions'));
    const path = join(root, 'sessions', 'saved.jsonl');
    await symlink(join(root, 'missing'), path);
    await writeFile(path + '.zst', zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: native } }) + '\n')));
    await expect(desktopTranscriptReference(root, path, native)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
