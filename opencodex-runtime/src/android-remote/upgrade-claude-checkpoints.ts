/** Export-only reconciliation of the old UI checkpoint cache. A user echo was
 * sometimes cached as a restore point before a native snapshot existed. Keep
 * those records verbatim, but never offer an unproven file-restore action. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { UPGRADE_BUSY } from './upgrade-export';
type Row = Record<string, any>;
export async function reconcileUpgradeCheckpoints(session: Row, transcript: string): Promise<Row> {
  if (!Array.isArray(session.fileCheckpoints) || !session.fileCheckpoints.length) return session;
  const file = await open(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) throw Error(UPGRADE_BUSY);
    const checkpoints = new Set<string>(), chunk = Buffer.allocUnsafe(65536);
    const deadline = Date.now() + 120_000;
    let bytes = 0, rows = 0, pending = Buffer.alloc(0);
    for (;;) {
      if (Date.now() >= deadline) throw Error(UPGRADE_BUSY);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > before.size) throw Error(UPGRADE_BUSY);
      pending = Buffer.concat([pending,chunk.subarray(0,bytesRead)]);
      let end: number;
      while ((end=pending.indexOf(10))>=0) {
        if (++rows > 200_000 || end>8*1024*1024) throw Error(UPGRADE_BUSY);
        const line=pending.subarray(0,end);pending=pending.subarray(end+1);
        if (!line.toString('utf8').trim()) continue;
        const row=JSON.parse(line.toString('utf8'));
        if (row.sessionId && row.sessionId!==session.nativeId) throw Error(UPGRADE_BUSY);
        if (row.type==='file-history-snapshot' && typeof row.messageId==='string') checkpoints.add(row.messageId);
      }
      if (pending.length>8*1024*1024) throw Error(UPGRADE_BUSY);
    }
    const after=await file.stat();
    if(pending.length || bytes!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs) throw Error(UPGRADE_BUSY);
    const missing=session.fileCheckpoints.filter((p:Row)=>!checkpoints.has(p.id));
    return missing.length ? {...session,fileCheckpoints:session.fileCheckpoints.filter((p:Row)=>checkpoints.has(p.id)),
      retainedFileCheckpoints:[...(session.retainedFileCheckpoints??[]),...missing]} : session;
  } finally { await file.close(); }
}
