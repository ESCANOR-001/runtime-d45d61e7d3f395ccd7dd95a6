/** Upgrade-only reader. Never resume a Desktop-owned chat in a second CLI.
 * A confirmed absent owner permits a read-only dormant export; an unreachable
 * discovery bus or ownership change is not proof of dormancy. */
import { transcriptFingerprint, UPGRADE_BUSY } from './upgrade-export';
import { desktopTranscriptReference } from './upgrade-desktop-reference';
import { openUpgradeRollout, upgradeRolloutChunks } from './upgrade-rollout';

type Row = Record<string, any>;
type Client = { request(method: string, params: Row): Promise<any> };
const LIMIT = 12 * 1024 * 1024;
const LINE = 8 * 1024 * 1024;
function object(v: any): v is Row { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function id(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f]/u.test(v)) throw new Error(UPGRADE_BUSY);
  return v;
}
function cursor(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !v || v.length > 8192) throw new Error(UPGRADE_BUSY);
  return v;
}
async function lifecycle(profile: string, path: string, native: string, deadline: number, reference = false): Promise<{ latest: { turn: string; status: string } | null; settings: Row | null }> {
  const { file, meta, compressed } = await openUpgradeRollout(profile, path);
  try {
    // References retain only identity and last-used settings. Stream large
    // rollouts in place instead of applying the full-history export bound.
    const maxBytes = (reference ? 2048 : 512) * 1024 * 1024;
    if (!meta.isFile() || meta.nlink !== 1 || meta.size > maxBytes) throw new Error(UPGRADE_BUSY);
    let pending = Buffer.alloc(0), first = true, latest: { turn: string; status: string } | null = null, bytes = 0;
    let skippingPayload = false;
    const isContext = (line: Buffer) => /"type"\s*:\s*"(?:turn_context|thread_settings_applied)"/.test(line.subarray(0, 512).toString('utf8'));
    let settings: Row | null = null;
    for await (const chunk of upgradeRolloutChunks(file, compressed, meta.size, maxBytes, deadline)) {
      bytes += chunk.length;
      let incoming = chunk;
      if (skippingPayload) {
        const newline = incoming.indexOf(10);
        if (newline < 0) continue;
        incoming = incoming.subarray(newline + 1); skippingPayload = false;
      }
      pending = Buffer.concat([pending, incoming]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        // A Desktop reference is an identity/settings record, not a copy of
        // its transcript. Large image/tool rows remain with the original owner.
        if (reference && !first && !isContext(line)) continue;
        if (end > LINE) throw new Error(UPGRADE_BUSY);
        const row = JSON.parse(line.toString('utf8'));
        if (first) {
          if (row.type !== 'session_meta' || row.payload?.id !== native) throw new Error(UPGRADE_BUSY);
          first = false;
        }
        const appliedSettings = row.type === 'event_msg' && row.payload?.type === 'thread_settings_applied';
        if (row.type === 'turn_context' || appliedSettings) {
          // Forks retain ancestor events. Only this chat's applied selections
          // override its inherited turn context.
          if (appliedSettings && row.payload.thread_id !== native) continue;
          const p = appliedSettings ? row.payload.thread_settings : row.payload;
          if (!object(p)) throw new Error(UPGRADE_BUSY);
          // Retain only last-used selections, never system/environment text.
          settings = { model: p.model, cwd: p.cwd, effort: p.reasoning_effort ?? p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? null,
            serviceTier: p.service_tier ?? null, mode: p.collaboration_mode?.mode ?? 'default',
            runtimeMode: p.approval_policy === 'never' && (p.sandbox_policy?.type === 'danger-full-access'
              || p.active_permission_profile?.id === ':full-access')
              ? 'full-access' : 'approval-required' };
        }
        if (row.type !== 'event_msg') continue;
        const status = ({ task_started: 'inProgress', task_complete: 'completed', turn_aborted: 'interrupted' } as Row)[row.payload?.type];
        if (status) latest = { turn: id(row.payload.turn_id), status };
      }
      if (pending.length > LINE) {
        if (!reference || first || isContext(pending)) throw new Error(UPGRADE_BUSY);
        pending = Buffer.alloc(0); skippingPayload = true;
      }
    }
    if (first || !reference && pending.length || !compressed && bytes !== meta.size) throw new Error(UPGRADE_BUSY);
    if (compressed) {
      const after = await file.stat();
      if (after.size !== meta.size || after.mtimeMs !== meta.mtimeMs || after.ctimeMs !== meta.ctimeMs) throw new Error(UPGRADE_BUSY);
    }
    return { latest, settings };
  } finally { await file.close(); }
}

/** Cap every native page and the accumulated projection; reject partial exports
 * and racing remote prompts. Saved readers can falsely call a live turn stopped,
 * so the final native lifecycle event, not that projection, decides readiness. */
export async function readDesktopExportThread(client: Client, native: string, profile: string, ownerConnected: () => Promise<boolean | null>): Promise<Row> {
  const owner = await ownerConnected();
  if (owner === null) throw new Error(UPGRADE_BUSY);
  const thread = (await client.request('thread/read', { threadId: native, includeTurns: false }))?.thread;
  if (!object(thread) || thread.id !== native || typeof thread.path !== 'string' || thread.turns?.length) throw new Error(UPGRADE_BUSY);
  const before = await transcriptFingerprint(profile, thread.path);
  const deadline = Date.now() + 120_000;
  const { latest } = await lifecycle(profile, thread.path, native, deadline);
  if (latest?.status === 'inProgress') throw new Error(UPGRADE_BUSY);
  const turns: Row[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let next: string | null = null, bytes = 0;
  do {
    if (Date.now() > deadline || turns.length >= 10000) throw new Error(UPGRADE_BUSY);
    const page = await client.request('thread/turns/list', { threadId: native, cursor: next, limit: 1, sortDirection: 'asc', itemsView: 'notLoaded' });
    if (!Array.isArray(page?.data) || page.data.length > 1) throw new Error(UPGRADE_BUSY);
    for (const turn of page.data) {
      if (!object(turn) || ids.has(id(turn.id)) || !['completed', 'interrupted', 'failed'].includes(turn.status)) throw new Error(UPGRADE_BUSY);
      ids.add(turn.id);
      const items: Row[] = [], seen = new Set<string>(), pages = new Set<string>();
      let token: string | null = null;
      do {
        if (Date.now() > deadline || items.length >= 32768) throw new Error(UPGRADE_BUSY);
        const part = await client.request('thread/items/list', { threadId: native, turnId: turn.id, cursor: token, limit: 8, sortDirection: 'asc' });
        if (!Array.isArray(part?.data) || part.data.length > 8) throw new Error(UPGRADE_BUSY);
        for (const row of part.data) {
          const item = row?.item ?? row;
          if (!object(item) || seen.has(id(item.id))) throw new Error(UPGRADE_BUSY);
          seen.add(item.id);
          bytes += Buffer.byteLength(JSON.stringify(item));
          if (bytes > LIMIT) throw new Error('This history exceeds the bounded upgrade projection; all source history is retained.');
          items.push(item);
        }
        token = cursor(part.nextCursor);
        if (token && (!part.data.length || pages.has(token))) throw new Error(UPGRADE_BUSY);
        if (token) pages.add(token);
      } while (token);
      turns.push({ ...turn, items, itemsView: 'full', ...(latest && latest.turn === turn.id ? { status: latest.status } : {}) });
    }
    next = cursor(page.nextCursor);
    if (next && (!page.data.length || cursors.has(next))) throw new Error(UPGRADE_BUSY);
    if (next) cursors.add(next);
  } while (next);
  if ((latest === null) !== (turns.length === 0) || latest && turns.at(-1)?.id !== latest.turn) throw new Error(UPGRADE_BUSY);
  if (await ownerConnected() !== owner) throw new Error(UPGRADE_BUSY);
  const after = await transcriptFingerprint(profile, thread.path);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw new Error(UPGRADE_BUSY);
  return { ...thread, turns, status: { type: 'idle' } };
}

/** Unaliased Desktop chats keep the native UUID as their public ID. Capture
 * actual last-used selections; never use the UI's fallback model for migration.
 * Future turns inherit the live Desktop owner's settings through its IPC API. */
export async function readDesktopExportHeader(client: Client, native: string, profile: string, ownerConnected: () => Promise<boolean | null>): Promise<Row> {
  const owner = await ownerConnected();
  if (owner === null) throw new Error(UPGRADE_BUSY);
  const thread = (await client.request('thread/read', { threadId: native, includeTurns: false }))?.thread;
  if (!object(thread) || thread.id !== native || typeof thread.path !== 'string'
    || thread.turns?.length || typeof thread.modelProvider !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(thread.modelProvider)) throw new Error(UPGRADE_BUSY);
  const before = await desktopTranscriptReference(profile, thread.path, native);
  const { settings } = await lifecycle(profile, thread.path, native, Date.now() + 120_000, true);
  // The live native index can move a chat to another folder without appending
  // a turn. Its current cwd is authoritative; old turn context stays unchanged.
  if (!settings
    || typeof settings.model !== 'string' || !settings.model || settings.model.length > 256
    || !['default', 'plan'].includes(settings.mode)
    || [settings.effort, settings.serviceTier].some(v => v !== null && (typeof v !== 'string' || !v || v.length > 128))) throw new Error(UPGRADE_BUSY);
  if (await ownerConnected() === null) throw new Error(UPGRADE_BUSY);
  const after = await desktopTranscriptReference(profile, thread.path, native);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw new Error(UPGRADE_BUSY);
  return { ...thread, status: { type: 'notLoaded' }, androidRemoteModel: settings.model,
    androidRemoteRuntimeMode: settings.runtimeMode, androidRemoteInteractionMode: settings.mode,
    androidRemoteNativeEffort: settings.effort, androidRemoteNativeServiceTier: settings.serviceTier };
}
