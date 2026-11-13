import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpgradeAdmission, readOwnedExportThread, assertSettledExport, exportOwnedUpgrade, transcriptFingerprint, type UpgradeExportOwner } from '../src/android-remote/upgrade-export';

describe('source-owner native upgrade export', () => {
  test('export closes admission while accepted work drains and restores it after a bounded timeout', async () => {
    const gate = new UpgradeAdmission();
    const leave = gate.enter();
    const reserved = gate.reserveWhenSettled(1000);
    expect(() => gate.enter()).toThrow();
    await expect(gate.reserveWhenSettled()).rejects.toThrow();
    let settled = false;
    void reserved.then(() => { settled = true; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    leave();
    const release = await reserved;
    expect(() => gate.enter()).toThrow();
    release(); release();
    const held = gate.enter();
    await expect(gate.reserveWhenSettled(5)).rejects.toThrow();
    gate.enter()();
    held();
    (await gate.reserveWhenSettled())();
  });
  test('admission reservation cannot overlap accepted work and releases idempotently', () => {
    const gate = new UpgradeAdmission();
    const leave = gate.enter();
    expect(() => gate.reserve()).toThrow();
    leave(); leave();
    const release = gate.reserve();
    expect(() => gate.enter()).toThrow();
    expect(() => gate.reserve()).toThrow();
    release();
    gate.enter()();
    const second = gate.reserve(); release();
    expect(() => gate.enter()).toThrow(); second();
  });
  test('does not classify unknown, running, queued, partial or approval-wait history as settled', () => {
    const idle = { session: { status: 'idle' }, messages: [], latestTurn: { state: 'completed' } };
    assertSettledExport(idle);
    // A finished failure is retained as history, not mistaken for live work.
    for (const status of ['error', 'interrupted']) {
      const ended = { ...idle, session: { status, activeTurnId: null }, latestTurn: { state: status } };
      expect(() => assertSettledExport(ended)).not.toThrow();
      expect(() => assertSettledExport({ ...ended, session: { status, activeTurnId: 'live-turn' } })).toThrow();
      expect(() => assertSettledExport({ ...ended, latestTurn: { state: 'running' } })).toThrow();
    }
    for (const change of [
      { session: { status: 'unknown' } }, { session: { status: 'running' } },
      { latestTurn: { state: 'inProgress' } }, { hasPendingApprovals: true },
      { hasPendingUserInput: true }, { messages: [{ phase: 'queued' }] },
      { messages: [{ streaming: true }] }, { historyPage: { olderCursor: 'more' } },
    ]) expect(() => assertSettledExport({ ...idle, ...change })).toThrow();
  });
  for (const race of ['none', 'input', 'stop-failure', 'busy'] as const) {
    test(`shutdown receipt: ${race}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'remodex-export-'));
      try {
        const codex = join(root, 'codex'), claude = join(root, 'claude'), output = join(root, 'export');
        await mkdir(codex); await mkdir(claude);
        const path = join(codex, 'rollout.jsonl');
        await writeFile(path, 'original history\n');
        let stopped = false, released = false, checks = 0;
        const owner: UpgradeExportOwner = {
          environment: 'test-only', connection: { clients: [] }, projects: [], claudeSettings: {},
          chats: (async function* () { yield { agent: 'codex' as const, id: 'chat', transcript: path, history: { keep: 'all messages' } }; })(),
          assertSettled() { if (++checks === 2 && race === 'busy') throw new Error('busy'); },
          async stop() {
            stopped = true;
            if (race === 'input') await writeFile(path, 'new remote input\n');
            if (race === 'stop-failure') throw new Error('not stopped');
          },
          release() { released = true; },
        };
        if (race === 'none') {
          const result = await exportOwnedUpgrade(output, { codex, claude }, owner);
          expect(result.chats).toBe(1);
          const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
          expect(receipt.profile_mode).toBe('existing');
          expect(receipt.chats[0].transcript).toBe('rollout.jsonl');
          expect(receipt.chats[0].sha256).toHaveLength(64);
          expect(stopped).toBe(true); expect(released).toBe(false);
        } else {
          await expect(exportOwnedUpgrade(output, { codex, claude }, owner)).rejects.toThrow();
          expect(await readdir(output)).not.toContain('closed-owner.json');
          expect(stopped).toBe(race !== 'busy');
          expect(released).toBe(race === 'busy');
        }
        expect(JSON.parse(await readFile(join(output, 'codex-0.json'), 'utf8'))).toEqual({ keep: 'all messages' });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  test('native proof rejects escaping paths and links without reading their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remodex-proof-'));
    try {
      const profile = join(root, 'profile'); await mkdir(profile);
      const outside = join(root, 'outside'); await writeFile(outside, 'private');
      await expect(transcriptFingerprint(profile, outside)).rejects.toThrow();
      if (process.platform !== 'win32') {
        const link = join(profile, 'link'); await symlink(outside, link);
        await expect(transcriptFingerprint(profile, link)).rejects.toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


test('owned export mounts cold history without sending a prompt and refuses active states', async () => {
  for (const state of ['notLoaded', 'idle', 'active']) {
    const calls: string[] = [];
    const client = { async request(method: string, params: any) {
      calls.push(method);
      if (method === 'thread/loaded/list') return { data: state === 'notLoaded' ? [] : ['chat'] };
      if (method === 'thread/resume') { expect(params.excludeTurns).toBe(true); return { thread: { id: 'chat', status: { type: 'idle' } } }; }
      expect(method).toBe('thread/read');
      return { thread: { id: 'chat', status: { type: params.includeTurns ? 'idle' : state }, turns: [] } };
    } };
    if (state === 'active') { await expect(readOwnedExportThread(client, 'chat')).rejects.toThrow(); expect(calls).toEqual(['thread/loaded/list', 'thread/read']); }
    else { await readOwnedExportThread(client, 'chat'); expect(calls).toEqual(state === 'notLoaded' ? ['thread/loaded/list', 'thread/resume', 'thread/read'] : ['thread/loaded/list', 'thread/read', 'thread/read']); }
  }
  const wrong = { async request() { return { thread: { id: 'different', status: 'idle', turns: [] } }; } };
  await expect(readOwnedExportThread(wrong, 'chat')).rejects.toThrow();
});

test('only unused Claude drafts can be retained without a native transcript', async () => {
 const { emptyUpgradeDraft }=await import('../src/android-remote/upgrade-export');
 const draft={thread:{session:{status:'ready',activeTurnId:null},latestTurn:null,messages:[],activities:[],proposedPlans:[]},commands:['previous-create-id']};
 expect(emptyUpgradeDraft(draft)).toBe(true);
 for(const change of [{bridgeId:'cse_existing'}, {external:true}, {deliveries:[{state:'consumed'}]}, {userUuids:['saved-id']}, {thread:{...draft.thread,messages:[{role:'user',text:'Keep me'}]}}]) expect(emptyUpgradeDraft({...draft,...change})).toBe(false);
});
