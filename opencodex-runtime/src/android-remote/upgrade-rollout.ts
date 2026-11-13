/** Read Codex's plain/compressed representations without materializing a file
 * in its profile. The logical .jsonl name stays stable across compression. */
import { constants } from 'node:fs';
import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createZstdDecompress, constants as zlibConstants } from 'node:zlib';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const ERROR = 'The original Desktop chat identity could not be verified; no chat was moved.';
function nativeSpelling(path: string): string {
  if (process.platform !== 'win32') return path;
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return /^\\\\\?\\[A-Za-z]:\\/.test(path) ? path.slice(4) : path;
}
export async function openUpgradeRollout(profile: string, path: string) {
  profile = nativeSpelling(profile); path = nativeSpelling(path);
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(ERROR);
  const logical = path.endsWith('.jsonl.zst') ? path.slice(0, -4) : path;
  const root = nativeSpelling(await realpath(profile)), local = relative(resolve(profile), logical);
  const parts = local.split(sep);
  if (!['sessions', 'archived_sessions'].includes(parts[0]!) || parts.length < 2
    || parts.some(p => !p || p === '.' || p === '..') || isAbsolute(local)) throw new Error(ERROR);
  let checked = root;
  for (const part of parts.slice(0, -1)) {
    checked = resolve(checked, part);
    if (nativeSpelling(await realpath(checked)) !== checked) throw new Error(ERROR);
  }
  const plain = resolve(checked, parts.at(-1)!);
  let physical = plain, compressed = false;
  try {
    const named = await lstat(plain);
    if (!named.isFile() || named.isSymbolicLink()) throw new Error(ERROR);
    if (nativeSpelling(await realpath(plain)) !== plain) throw new Error(ERROR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !plain.endsWith('.jsonl')) throw error;
    physical = plain + '.zst'; compressed = true;
    if (nativeSpelling(await realpath(physical)) !== physical) throw new Error(ERROR);
  }
  const file = await open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.nlink !== 1 || !meta.size) throw new Error(ERROR);
    return { file, meta, physical, compressed, relative: parts.join('/') };
  } catch (error) { await file.close(); throw error; }
}

export async function* upgradeRolloutChunks(file: FileHandle, compressed: boolean, size: number,
  limit: number, deadline: number): AsyncGenerator<Buffer> {
  if (!compressed) {
    let count = 0;
    while (count < size) {
      if (Date.now() >= deadline) throw new Error(ERROR);
      const chunk = Buffer.alloc(Math.min(65536, size - count));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead || (count += bytesRead) > limit) throw new Error(ERROR);
      yield chunk.subarray(0, bytesRead);
    }
    return;
  }
  // Keep ownership of the handle here. Bun's FileHandle read stream can close
  // it when destroyed even with autoClose:false, preventing the identity check.
  const input = Readable.from(upgradeRolloutChunks(file, false, size, size, deadline),
    { objectMode: false, highWaterMark: 65536 });
  const decoder = createZstdDecompress({ chunkSize: 65536,
    params: { [zlibConstants.ZSTD_d_windowLogMax]: 27 } });
  input.on('error', error => decoder.destroy(error));
  input.pipe(decoder);
  let count = 0;
  try {
    for await (const value of decoder) {
      const chunk = Buffer.from(value);
      if (Date.now() >= deadline || (count += chunk.length) > limit) throw new Error(ERROR);
      yield chunk;
    }
  } finally {
    input.unpipe(decoder); input.destroy(); decoder.destroy();
    await finished(input).catch(() => {});
  }
}
