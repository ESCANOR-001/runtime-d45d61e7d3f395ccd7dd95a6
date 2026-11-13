import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportOwnedUpgrade, transcriptFingerprint } from '../src/android-remote/upgrade-export';
import { claudeNativeUploads } from '../src/android-remote/upgrade-native-assets';
import { exportChatAssets } from '../src/android-remote/upgrade-export-assets';
import { assertUpgradeSourceAvailable, SOURCE_HOLD } from '../src/android-remote/upgrade-source-hold';

test('embedded uploads retain the configured root alias but refuse links inside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-upload-alias-'));
  try {
    const target = join(root, 'target'), uploads = join(root, 'uploads');
    await mkdir(target);
    await symlink(target, uploads, process.platform === 'win32' ? 'junction' : 'dir');
    const transcript = join(root, 'session.jsonl');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
    const history = { nativeId: 'session', thread: { messages: [{ id: 'prompt', role: 'user', text: 'image' }] } };
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'session', uuid: 'prompt', message: { role: 'user', content: [
      { type: 'text', text: 'image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
    ] } }) + '\n');
    const recovered = await claudeNativeUploads(transcript, history, uploads, transcriptFingerprint);
    expect(recovered).toHaveLength(1);
    expect(dirname(dirname(recovered[0]!.path))).toBe(join(uploads, 'recovered-native'));
    expect(await readFile(recovered[0]!.path)).toEqual(bytes);
    await rm(join(target, 'recovered-native'), { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(target, 'recovered-native'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(claudeNativeUploads(transcript, history, uploads, transcriptFingerprint)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex staged sections retain all files; arbitrary prose is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-codex-assets-'));
  try {
    const uploads = join(root, 'android-remote-files');
    const directory = join(uploads, 'phone', '00000000-0000-4000-8000-000000000001');
    await mkdir(directory, { recursive: true });
    const paths = ['one.txt', 'two.txt', 'image.png'].map(n => join(directory, n));
    for (const p of paths) await writeFile(p, 'retained');
    const text = `Inspect\n\nFiles uploaded from Android and staged on this PC:\n- ${paths[0]}\n- ${paths[1]}\n[Image: ${paths[2]}]`;
    const output = join(root, 'export'); await mkdir(output);
    const chat = { id: 'chat', agent: 'codex', history: { messages: [{ id: 'prompt', role: 'user', text }], activities: [] } };
    const result = await exportChatAssets(output, 0, chat, { uploads, images: root }, transcriptFingerprint, () => {});
    expect(result.proofs.length).toBe(3);
    const claude = { id: 'claude-chat', agent: 'claude', history: { thread: { messages: [{ id: 'native-prompt', role: 'user', text: `Inspect\n\nAttached files on this PC:\n${paths[0]}` }] } } };
    const retained = await exportChatAssets(output, 2, claude, { uploads, images: root }, transcriptFingerprint, () => {});
    expect(retained.proofs.map(p => p.path)).toEqual([paths[0]!]);
    for (const bad of [paths[0]!, `- ${paths[0]}`, `${text}\nordinary trailing prose`]) {
      chat.history.messages[0]!.text = bad;
      await expect(exportChatAssets(output, 1, chat, { uploads, images: root }, transcriptFingerprint, () => {})).rejects.toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['okay', 'changed', 'missing'] as const) test(`owned export retains attachments, tool images and startup hold: ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-assets-'));
  try {
    const source = join(root, 'source'), output = join(root, 'closed'), codex = join(root, 'codex'), claude = join(root, 'claude');
    const uploads = join(root, 'android-remote-files'), images = join(root, 'images');
    await Promise.all([source, codex, claude].map(p => mkdir(p)));
    const transcript = join(claude, 'history.jsonl'); await writeFile(transcript, 'native history\n');
    const file = join(uploads, 'phone', '00000000-0000-4000-8000-000000000001', 'note.txt');
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'KEEP FILE');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
    const hash = createHash('sha256').update(png).digest('hex');
    const bucket = createHash('sha256').update('chat').digest('hex');
    const image = join(images, bucket, `${hash}.png`);
    await mkdir(join(image, '..'), { recursive: true }); await writeFile(image, png);
    if (mode === 'missing') await rm(file);
    const history = { version: 1, thread: { id: 'chat', messages: [{ id: 'prompt', text: `See [note](<${file}>)`, attachments: [{ path: file }] }], activities: [{ payload: { data: { toolImages: [image] } } }] } };
    let stopped = false, released = false;
    const run = () => exportOwnedUpgrade(output, { codex, claude }, {
      environment: 'test', sourceRoot: source, assetRoots: { uploads, images },
      connection: {}, projects: [], claudeSettings: {}, assertSettled() {}, release() { released = true; },
      chats: (async function* () { yield { id: 'chat', agent: 'claude' as const, history, transcript }; })(),
      async stop() { stopped = true; expect(() => assertUpgradeSourceAvailable(source)).toThrow(); if (mode === 'changed') await writeFile(file, 'CHANGED'); },
    });
    if (mode === 'okay') {
      const result = await run();
      const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
      expect(receipt.source_hold).toBe(join(await realpath(source), SOURCE_HOLD));
      expect(await readFile(join(output, 'uploads-0/phone/00000000-0000-4000-8000-000000000001/note.txt'), 'utf8')).toBe('KEEP FILE');
      expect(await readFile(join(output, 'images-0', bucket, `${hash}.png`))).toEqual(png);
      expect(JSON.parse(await readFile(join(output, 'claude-0.json'), 'utf8'))).toEqual(history);
      expect(stopped).toBe(true); expect(released).toBe(false);
    } else {
      await expect(run()).rejects.toThrow();
      await expect(readFile(join(output, 'closed-owner.json'))).rejects.toThrow();
      expect(stopped).toBe(mode === 'changed'); expect(released).toBe(mode === 'missing');
      assertUpgradeSourceAvailable(source);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('even a partial source marker blocks an old restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-hold-'));
  try {
    assertUpgradeSourceAvailable(root);
    await writeFile(join(root, SOURCE_HOLD), '{');
    expect(() => assertUpgradeSourceAvailable(root)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('old Claude uploads are matched by native UUID; repeated text never chooses a message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-native-assets-'));
  try {
    const uploads = join(root, 'uploads');
    const file = join(uploads, 'phone', '00000000-0000-4000-8000-000000000001', 'note.txt');
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'KEEP ORIGINAL FILE');
    const transcript = join(root, 'session.jsonl');
    const history = { nativeId: 'session', thread: { messages: [{ id: 'first', role: 'user', text: 'same' }, { id: 'second', role: 'user', text: 'same' }] }, deliveries: [{ uuid: 'native-second', messageId: 'second', state: 'observed' }] };
    const value = { type: 'user', sessionId: 'session', uuid: 'native-second', message: { role: 'user', content: [{ type: 'text', text: `same\n\nAttached files on this PC:\n${file}` }] } };
    await writeFile(transcript, JSON.stringify(value) + '\n');
    expect(await claudeNativeUploads(transcript, history, uploads, transcriptFingerprint)).toEqual([{ path: file, message: 'second' }]);
    await expect(claudeNativeUploads(transcript, { ...history, deliveries: [] }, uploads, transcriptFingerprint)).rejects.toThrow();
    const first = { ...value, uuid: 'native-first', message: { role: 'user', content: [{ type: 'text', text: 'same' }] } };
    await writeFile(transcript, JSON.stringify(first) + '\n' + JSON.stringify(value) + '\n');
    const legacy = { ...history, deliveries: [], userUuids: ['native-first', 'native-second'] };
    expect(await claudeNativeUploads(transcript, legacy, uploads, transcriptFingerprint)).toEqual([{ path: file, message: 'second' }]);
    await expect(claudeNativeUploads(transcript, { ...legacy, userUuids: ['native-second', 'native-first'] }, uploads, transcriptFingerprint)).rejects.toThrow();
    await writeFile(transcript, JSON.stringify({ ...first, uuid: 'native-second' }) + '\n');
    expect(await claudeNativeUploads(transcript, legacy, uploads, transcriptFingerprint)).toEqual([]);
    const image = join(file, '..', 'image.png');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
    await writeFile(image, bytes);
    value.message.content = [{ type: 'text', text: 'same' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } } as any];
    await writeFile(transcript, JSON.stringify(value) + '\n');
    const recovered = await claudeNativeUploads(transcript, history, uploads, transcriptFingerprint);
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.message).toBe('second');
    expect(dirname(dirname(recovered[0]!.path))).toBe(join(uploads, 'recovered-native'));
    expect(await readFile(recovered[0]!.path)).toEqual(bytes);
    await writeFile(join(image, '..', 'ambiguous.png'), bytes);
    expect(await claudeNativeUploads(transcript, history, uploads, transcriptFingerprint)).toEqual(recovered);
    await writeFile(recovered[0]!.path, 'corrupted');
    await expect(claudeNativeUploads(transcript, history, uploads, transcriptFingerprint)).rejects.toThrow();
    await writeFile(transcript, JSON.stringify(value));
    await expect(claudeNativeUploads(transcript, history, uploads, transcriptFingerprint)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
