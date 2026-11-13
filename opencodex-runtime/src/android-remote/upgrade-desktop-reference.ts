/** Desktop remains the writer. Retain its original rollout, validating the
 * immutable session identity rather than requiring a running turn to stop. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { openUpgradeRollout, upgradeRolloutChunks } from './upgrade-rollout';

const ERROR = 'The original Desktop chat identity could not be verified; no chat was moved.';
const LIMIT = 8 * 1024 * 1024;
export async function desktopTranscriptReference(profile: string, path: string, native: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(native)) throw new Error(ERROR);
  const { file, meta, physical, compressed, relative } = await openUpgradeRollout(profile, path);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of upgradeRolloutChunks(file, compressed, meta.size, LIMIT + 65536, Date.now() + 120_000)) {
      const end = chunk.indexOf(10);
      const bytes = chunk.subarray(0, end < 0 ? chunk.length : end + 1);
      size += bytes.length; chunks.push(bytes);
      if (size > LIMIT) throw new Error(ERROR);
      if (end < 0) continue;
      const line = Buffer.concat(chunks, size), row = JSON.parse(line.toString('utf8'));
      if (row.type !== 'session_meta' || row.payload?.id !== native) throw new Error(ERROR);
      const named = await open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const now = await named.stat();
        if (now.ino !== meta.ino || now.dev !== meta.dev || !compressed && now.size < size
          || compressed && (now.size !== meta.size || now.mtimeMs !== meta.mtimeMs || now.ctimeMs !== meta.ctimeMs)) throw new Error(ERROR);
      } finally { await named.close(); }
      return { relative, sha256: createHash('sha256').update(line).digest('hex'), bytes: size };
    }
    throw new Error(ERROR);
  } finally { await file.close(); }
}
