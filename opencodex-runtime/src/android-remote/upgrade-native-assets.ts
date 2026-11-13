/** Recover uploads omitted by old Claude public messages, using native UUIDs.
 * Prompt-text equality is never used to choose a message or a source file. */
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
type Row = Record<string, any>;
const INVALID = 'Native attachment evidence is incomplete or ambiguous; keep the original installation and retry the export.';
type Proof = (root: string, path: string) => Promise<{ sha256: string; bytes: number }>;
async function retainEmbeddedImage(root: string, session: string, uuid: string, bytes: Buffer, hash: string, mediaType: string, proof: Proof): Promise<string> {
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mediaType];
  if (!extension) throw new Error(INVALID);
  // Claude can resize an uploaded image before persisting it. Retain the exact
  // embedded bytes rather than guessing which original upload produced them.
  const key = createHash('sha256').update(`${session}\0${uuid}`).digest('hex').slice(0, 32);
  const bucket = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  let directory = canonical;
  for (const part of ['recovered-native', bucket]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(directory) !== directory) throw new Error(INVALID);
  }
  const path = join(directory, `${hash}.${extension}`);
  const file = await open(path, 'wx', 0o600).catch(error => { if (error.code !== 'EEXIST') throw error; return null; });
  if (file) { try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
  // The configured root may itself be an alias (macOS /var, Windows junctions).
  // Keep that spelling for export ownership checks; children were checked above
  // against the canonical root, so links inside the upload tree stay forbidden.
  const configuredPath = join(resolve(root), 'recovered-native', bucket, `${hash}.${extension}`);
  if (await realpath(root) !== canonical) throw new Error(INVALID);
  const verified = await proof(root, configuredPath);
  if (verified.sha256 !== hash || verified.bytes !== bytes.length) throw new Error(INVALID);
  return configuredPath;
}
export async function claudeNativeUploads(path: string, history: Row, root: string, proof: Proof): Promise<{ path: string; message: string }[]> {
  const messages = new Map<string, Row>((history.thread.messages ?? []).filter((m: Row) => m.role === 'user').map((m: Row) => [m.id, m]));
  const native = new Map<string, Row>(messages);
  for (const d of history.deliveries ?? []) if (d.state !== 'cancelled' && messages.has(d.messageId)) native.set(d.uuid, messages.get(d.messageId)!);
  // Older releases persisted a complete ordered UUID list before delivery
  // records existed. Use it only when it covers every public user message and
  // the transcript independently confirms the same complete order.
  const users = [...messages.values()];
  const legacyOrder: string[] = !(history.deliveries?.length) && Array.isArray(history.userUuids)
    && history.userUuids.length === users.length && new Set(history.userUuids).size === users.length
    && history.userUuids.every((id: unknown) => typeof id === 'string' && id.length > 0)
    ? history.userUuids : [];
  const ordered = new Map(legacyOrder.map((id, index) => [id, index]));
  let observedOrder = 0, validOrder = true, legacyUsed = false;
  for (const [index, id] of legacyOrder.entries()) {
    if (native.has(id) && native.get(id) !== users[index]) throw new Error(INVALID);
    native.set(id, users[index]!);
  }
  const found = new Map<string, string>();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const before = await file.stat();
  const seen = new Set<string>();
  const deadline = Date.now() + 120_000;
  const pending = Buffer.allocUnsafe(8 * 1024 * 1024 + 64 * 1024);
  let length = 0, total = 0, lines = 0;
  try {
    if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) throw new Error(INVALID);
    for (;;) {
      if (Date.now() >= deadline) throw new Error(INVALID);
      const { bytesRead } = await file.read(pending, length, 64 * 1024, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size) throw new Error(INVALID);
      length += bytesRead;
      let start = 0;
      for (;;) {
        const end = pending.subarray(0, length).indexOf(10, start);
        if (end < 0) break;
        if (end - start > 8 * 1024 * 1024 || ++lines > 200_000) throw new Error(INVALID);
        const line = pending.subarray(start, end).toString(); start = end + 1;
        if (!line.trim()) continue;
        let value: Row; try { value = JSON.parse(line); } catch { throw new Error(INVALID); }
        if (value.type !== 'user' || value.isMeta || value.isSynthetic || value.isSidechain || value.parent_tool_use_id || value.sessionId !== history.nativeId || value.message?.role !== 'user') continue;
        if (ordered.has(value.uuid)) {
          if (ordered.get(value.uuid) !== observedOrder++) validOrder = false;
        }
        const blocks = value.message.content;
        if (!Array.isArray(blocks) || !blocks.length || blocks[0].type !== 'text') continue;
        const text = blocks[0].text;
        if (typeof text !== 'string') throw new Error(INVALID);
        if (!text.includes('\n\nAttached files on this PC:\n') && !blocks.some((b: Row) => b.type === 'image')) continue;
        const message = native.get(value.uuid);
        if (!message || seen.has(value.uuid) || blocks.slice(1).some((b: Row) => b.type !== 'image')) throw new Error(INVALID);
        if (ordered.has(value.uuid) && !messages.has(value.uuid)) legacyUsed = true;
        seen.add(value.uuid);
        const prompt = message.text || 'Inspect the attached files.';
        if (text !== prompt) {
          const prefix = `${prompt}\n\nAttached files on this PC:\n`;
          if (!text.startsWith(prefix)) throw new Error(INVALID);
          for (const path of text.slice(prefix.length).split('\n')) {
            const name = relative(root, path);
            if (!isAbsolute(path) || !name || name.startsWith('..' + sep) || name === '..' || isAbsolute(name)) throw new Error(INVALID);
            if (!found.has(path)) found.set(path, message.id);
          }
        }
        for (const image of blocks.slice(1)) {
          const source = image.source;
          if (source?.type !== 'base64' || typeof source.data !== 'string' || source.data.length > 14 * 1024 * 1024) throw new Error(INVALID);
          const bytes = Buffer.from(source.data, 'base64');
          if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== source.data) throw new Error(INVALID);
          const hash = createHash('sha256').update(bytes).digest('hex');
          const imagePath = await retainEmbeddedImage(root, history.nativeId, value.uuid, bytes, hash, source.media_type, proof);
          found.set(imagePath, message.id);
        }
        if (found.size > 2048) throw new Error(INVALID);
      }
      if (start) { pending.copyWithin(0, start, length); length -= start; }
      if (length > 8 * 1024 * 1024) throw new Error(INVALID);
    }
    const after = await file.stat();
    if (total !== before.size || length || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || legacyUsed && (!validOrder || observedOrder !== legacyOrder.length)) throw new Error(INVALID);
  } finally { await file.close(); }
  return [...found].map(([path, message]) => ({ path, message }));
}
