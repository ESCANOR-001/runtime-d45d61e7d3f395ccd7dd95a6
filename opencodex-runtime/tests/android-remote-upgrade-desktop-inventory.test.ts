import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCodexThreadDetail } from '../src/android-remote/projection';
import { assertSettledExport } from '../src/android-remote/upgrade-export';
import { readMissingDesktopUpgradeHeaders, desktopUpgradeAliases, annotateUpgradeAlias, unmappedDraftSelectionIds, retainUnavailableCodexMetadata } from '../src/android-remote/upgrade-desktop-inventory';
import { readDesktopExportHeader } from '../src/android-remote/upgrade-desktop-history';

const old = '11111111-1111-4111-8111-111111111111';
const fresh = '22222222-2222-4222-8222-222222222222';
test('unmapped phone draft selections remain inert and unchanged during upgrade', async () => {
  const draft = 'thread-mtqrxd82-vael8nqe';
  const selection = { nativeThreadId: draft, remoteThreadId: draft, model: 'saved-choice' };
  const connection = { threadAliases: [], taskSelections: [selection] };
  const retained = new Set<string>();
  const client = { request: async (method: string) => {
    expect(method).toBe('thread/list'); return { data: [], nextCursor: null };
  } };
  expect(await readMissingDesktopUpgradeHeaders(client, '/unused', new Set(), async () => { throw Error('A draft has no native owner to probe'); }, {
    selections: new Set([draft]), unmappedDrafts: unmappedDraftSelectionIds(connection), retainUnavailable: id => retained.add(id),
  })).toEqual([]);
  const exported: any = retainUnavailableCodexMetadata(connection, retained);
  expect(exported.taskSelections).toEqual([]);
  expect(exported.retainedCodexMetadata.selections).toEqual([selection]);
  expect(connection.taskSelections).toEqual([selection]);
  expect(unmappedDraftSelectionIds({ ...connection, threadAliases: [{ remoteThreadId: draft, nativeThreadId: old }] }).size).toBe(0);
  expect(unmappedDraftSelectionIds({ threadAliases: [], taskSelections: [{ ...selection, remoteThreadId: 'different' }] }).size).toBe(0);
  await expect(readMissingDesktopUpgradeHeaders(client, '/unused', new Set([draft]), async () => false, {
    selections: new Set([draft]), unmappedDrafts: new Set([draft]), retainUnavailable: () => { throw Error('Must not retain a mapped native identity'); },
  })).rejects.toThrow();
});
test('Desktop references retain moved chats and stream past large tool payloads without rewriting history', async () => {
 const root = await mkdtemp(join(tmpdir(), 'upgrade-reference-large-'));
 try {
  await mkdir(join(root, 'sessions'));
  const path = join(root, 'sessions', fresh + '.jsonl');
  const source = JSON.stringify({type:'session_meta',payload:{id:fresh}})+'\n'
   + JSON.stringify({type:'response_item',payload:{text:'x'.repeat(9*1024*1024)}})+'\n'
   + JSON.stringify({type:'turn_context',payload:{cwd:'/old-folder',model:'saved-model',approval_policy:'on-request'}})+'\n';
  await writeFile(path,source);
  const header = {id:fresh,path,cwd:'/moved-folder',modelProvider:'openai',createdAt:1,updatedAt:2};
  const result = await readDesktopExportHeader({request:async()=>({thread:header})},fresh,root,async()=>false);
  expect(result).toMatchObject({cwd:'/moved-folder',androidRemoteModel:'saved-model',androidRemoteInteractionMode:'default'});
  expect(await readFile(path,'utf8')).toBe(source);
  await appendFile(path,JSON.stringify({type:'event_msg',payload:{type:'thread_settings_applied',thread_id:fresh,
   thread_settings:{cwd:'/moved-folder',model:'newly-selected',reasoning_effort:'high',collaboration_mode:{mode:'plan'},
    approval_policy:'never',active_permission_profile:{id:':full-access'}}}})+'\n');
  const selected = await readDesktopExportHeader({request:async()=>({thread:header})},fresh,root,async()=>false);
  expect(selected).toMatchObject({androidRemoteModel:'newly-selected',androidRemoteInteractionMode:'plan',androidRemoteNativeEffort:'high',androidRemoteRuntimeMode:'full-access'});
  await appendFile(path,JSON.stringify({type:'event_msg',payload:{type:'thread_settings_applied',thread_id:old,
   thread_settings:{model:'ancestor-model'}}})+'\n');
  expect((await readDesktopExportHeader({request:async()=>({thread:header})},fresh,root,async()=>false)).androidRemoteModel).toBe('newly-selected');
  await appendFile(path,'{"type":"turn_context","payload":null}\n');
  await expect(readDesktopExportHeader({request:async()=>({thread:header})},fresh,root,async()=>false)).rejects.toThrow();
 } finally { await rm(root,{recursive:true,force:true}); }
}, 30_000);
for (const mode of ['settled', 'dormant', 'archived', 'missing-owner', 'live', 'missing-settings', 'changed', 'cursor-cycle', 'missing-known', 'malformed-id', 'foreign-provider', 'changed-listing'] as const) {
  test(`unaliased Desktop inventory is complete and read-only: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-inventory-'));
    try {
      await mkdir(join(root, 'sessions'));
      const path = join(root, 'sessions', fresh + '.jsonl');
      const source = [{ type: 'session_meta', payload: { id: fresh } },
        ...(mode === 'missing-settings' ? [] : [{ type: 'turn_context', payload: { cwd: root, model: 'test-native-model', effort: 'high',
          collaboration_mode: { mode: 'plan' }, approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } }]),
        { type: 'event_msg', payload: { type: mode === 'live' ? 'task_started' : 'task_complete', turn_id: 'turn' } }].map(x => JSON.stringify(x)).join('\n') + '\n';
      await writeFile(path, source);
      const header = { id: fresh, cwd: root, path, createdAt: 10, updatedAt: 20, modelProvider: mode === 'foreign-provider' ? 'custom' : 'openai', turns: [] };
      const calls: string[] = [];
      const client = { async request(method: string, params: Record<string, any>) {
        calls.push(method);
        if (method === 'thread/list') {
          expect(params.limit).toBe(32);
          if (mode === 'cursor-cycle' && params.cursor) return { data: [], nextCursor: 'same' };
          return { data: [...(!params.archived && mode !== 'missing-known' ? [{ id: old }] : []),
            ...(params.archived === (mode === 'archived') ? [{ ...header, cwd: mode === 'changed-listing' ? '/cached-folder' : header.cwd, id: mode === 'malformed-id' ? '-'.repeat(36) : fresh, updatedAt: mode === 'changed-listing' ? 99 : 20 }] : []),
            ...(!params.archived && mode === 'changed-listing' ? [{...header}] : [])],
            nextCursor: mode === 'cursor-cycle' ? 'same' : null };
        }
        if (method === 'thread/read') { expect(params.threadId).toBe(fresh); expect(params.includeTurns).toBe(false); return { thread: header }; }
        throw Error('Unexpected mutation');
      } };
      let owners = 0;
      const result = readMissingDesktopUpgradeHeaders(client, root, new Set([old]), async id => {
        expect(id).toBe(fresh);
        if (++owners === 2 && mode === 'changed') await appendFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } }) + '\n');
        return mode === 'missing-owner' ? null : mode !== 'dormant';
      });
      if (mode === 'settled' || mode === 'dormant' || mode === 'archived' || mode === 'foreign-provider' || mode === 'live' || mode === 'changed' || mode === 'changed-listing') {
        const rows = await result;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: fresh, androidRemoteModel: 'test-native-model', androidRemoteInteractionMode: 'plan', androidRemoteNativeEffort: 'high', androidRemoteRuntimeMode: 'full-access' });
        expect(rows[0]?.androidRemoteArchivedAt !== null).toBe(mode === 'archived');
        expect((await readFile(path, 'utf8')).startsWith(source)).toBe(true);
      } else await expect(result).rejects.toThrow();
      expect(calls.every(method => ['thread/list', 'thread/read'].includes(method))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('export-only aliases preserve native IDs, projectless state and actual selections', () => {
  const header = { id: fresh, cwd: '/workspace', modelProvider: 'openai', androidRemoteModel: 'native-model', androidRemoteNativeEffort: 'high' };
  const thread = { id: fresh, projectId: 'codex-project-chats', title: 'Original', modelSelection: { model: 'native-model' },
    runtimeMode: 'approval-required', interactionMode: 'plan', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', archivedAt: null };
  const before = JSON.stringify(header);
  const { aliases } = desktopUpgradeAliases([header], { threads: [thread], projects: [] });
  expect(aliases[0]).toMatchObject({ remoteThreadId: fresh, nativeThreadId: fresh, workspaceKind: 'projectless', externalCodex: true, model: 'native-model', nativeReasoningEffort: 'high' });
  expect(annotateUpgradeAlias({ id: fresh }, aliases[0]!)).toMatchObject({ androidRemoteModel: 'native-model', androidRemoteProjectId: 'codex-project-chats' });
  expect(JSON.stringify(header)).toBe(before);
  expect(() => desktopUpgradeAliases([header], { threads: [{ ...thread, modelSelection: { model: 'fallback' } }], projects: [] })).toThrow();
});


test('current Plan selection does not turn all saved final answers into pending plans during export', () => {
  const alias:any={remoteThreadId:fresh,nativeThreadId:fresh,interactionMode:'plan',runtimeMode:'full-access',model:'native-model'};
  const native={id:fresh,cwd:'/workspace',createdAt:10,updatedAt:20,status:{type:'idle'},turns:[{
    id:'turn',status:'completed',items:[{id:'reply',type:'agentMessage',phase:'final_answer',text:'SAVED_REPLY'}]
  }]};
  const detail:any=projectCodexThreadDetail(annotateUpgradeAlias(native,alias),0).thread;
  expect(detail.messages.map((m:any)=>m.text)).toEqual(['SAVED_REPLY']);
  expect(detail.hasActionableProposedPlan).toBe(false);
  expect(()=>assertSettledExport(detail)).not.toThrow();
  expect(alias.interactionMode).toBe('plan');
  native.turns[0]!.items[0]!.text='<proposed_plan>\nActual saved plan\n</proposed_plan>';
  const plan:any=projectCodexThreadDetail(annotateUpgradeAlias(native,alias),0).thread;
  expect(plan.hasActionableProposedPlan).toBe(true);
  expect(()=>assertSettledExport(plan)).toThrow();
});

test('missing selection records are retained only after complete inventory and an explicit absent owner', async () => {
 const { retainUnavailableCodexMetadata } = await import('../src/android-remote/upgrade-desktop-inventory');
 for (const mode of ['missing', 'offline', 'owner-unknown', 'owner-live']) {
  const retained = new Set<string>();
  const client = { request: async (method:string) => {
   if (method === 'thread/list') return { data:[], nextCursor:null };
   throw Error(mode === 'offline' ? 'connection closed' : `thread not loaded: ${old}`);
  }};
  const result = readMissingDesktopUpgradeHeaders(client,'/unused',new Set([old]),
   async()=> mode==='owner-unknown'?null:mode==='owner-live',
   { selections:new Set([old]), retainUnavailable:id=>retained.add(id) });
  if(mode==='missing') {
   expect(await result).toEqual([]); expect([...retained]).toEqual([old]);
   const source={threadAliases:[{nativeThreadId:old,remoteThreadId:'saved'}],taskSelections:[{nativeThreadId:old,model:'custom/model'}]};
   const exported:any=retainUnavailableCodexMetadata(source,retained);
   expect(exported.threadAliases).toEqual([]);expect(exported.taskSelections).toEqual([]);
   expect(exported.retainedCodexMetadata.aliases).toEqual(source.threadAliases);
   expect(exported.retainedCodexMetadata.selections).toEqual(source.taskSelections);
   expect(source.threadAliases).toHaveLength(1);
  } else { await expect(result).rejects.toThrow();expect(retained.size).toBe(0); }
 }
});
