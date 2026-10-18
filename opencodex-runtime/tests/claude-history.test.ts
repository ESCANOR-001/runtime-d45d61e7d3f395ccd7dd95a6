import { expect, test } from 'bun:test';
import { ClaudeHistory, type ClaudeHistoryReader } from '../src/claude-code/history';
import { ClaudeToolImages } from '../src/claude-code/tool-images';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectedThreadStreamState, projectedThreadBoundedSnapshot, readProjectedOlderPage } from '../src/android-remote/thread-stream';
const info = { sessionId: 'native-greeting', summary: 'Greeting', cwd: '/workspace/GlinkBot', createdAt: 1000, lastModified: 2000, fileSize: 200 };
const msg = (type: string, uuid: string, content: any, parent_tool_use_id: string | null = null) => ({ type, uuid, message: { content }, parent_tool_use_id, timestamp: '2026-10-14T00:00:00.000Z' }) as any;

test('branch history uses the new UUIDs without publishing an imported Desktop duplicate', async () => {
 const h = new ClaudeHistory({ list: async () => [], info: async () => info,
   messages: async () => [msg('user', 'fork-user', 'Remember this'), msg('assistant', 'fork-answer', 'Remembered')] });
 const t = await h.branchDetail(info.sessionId, info.cwd, 'new-thread', []);
 expect(t.id).toBe('new-thread'); expect(t.nativeSessionId).toBe(info.sessionId);
 expect(t.messages.map((m: any) => m.id)).toEqual(['fork-user', 'fork-answer']);
 expect(h.shells([])).toEqual([]); expect(h.cachedDetail('new-thread')).toBeUndefined();
});

test('branch reads reject missing, mismatched and oversized native history before reading messages', async () => {
 let reads = 0;
 for (const entry of [undefined, { ...info, sessionId: 'other' }, { ...info, cwd: '/another/project' }, { ...info, fileSize: 17 * 1024 * 1024 }]) {
   const h = new ClaudeHistory({ list: async () => [], info: async () => entry, messages: async () => { reads++; return []; } });
   await expect(h.branchDetail(info.sessionId, info.cwd, 'new-thread', [])).rejects.toThrow();
 }
 expect(reads).toBe(0);
});

test('Desktop setup blocks are hidden without changing the real prompt, assistant text or tool results', async () => {
 const reminder = '<system-reminder>Internal scratch workspace instructions</system-reminder>\n\n';
 const literal = 'Explain this tag: <system-reminder>example</system-reminder>';
 const entries = [
   msg('user', 'greeting', [{ type: 'text', text: reminder }, { type: 'text', text: 'Hii' }]),
   msg('assistant', 'reply', [{ type: 'text', text: reminder }, { type: 'text', text: 'Hello' }]),
   msg('user', 'literal', [{ type: 'text', text: literal }]),
   msg('user', 'literal-string', reminder),
   msg('user', 'literal-block', [{ type: 'text', text: reminder }]),
   msg('user', 'fenced', [{ type: 'text', text: '```xml\n' + reminder + '```' }, { type: 'text', text: 'Explain this' }]),
   msg('assistant', 'tool', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/workspace/GlinkBot/a.txt' } }]),
   msg('user', 'tool-result', [{ type: 'tool_result', tool_use_id: 'read', content: reminder }]),
 ];
 const before = structuredClone(entries);
 const h = new ClaudeHistory({ list: async () => [info], messages: async () => entries });
 await h.refresh(new Set()); const t = await h.detail('claude-history-native-greeting', []);
 expect(t.messages.map((m: any) => m.text)).toEqual(['Hii', reminder + '\nHello', literal, reminder, reminder, '```xml\n' + reminder + '```\nExplain this']);
 expect(t.messages[0].id).toBe('greeting');
 expect(t.messages[1].turnId).toBe(t.messages[0].turnId);
 expect(t.activities.find((a: any) => a.id === 'read').payload.detail).toBe(reminder);
 expect(entries).toEqual(before);
});

test('ten-prompt Android pages reach the oldest prompt beyond 2000 native entries without gaps or duplicates', async () => {
 const entries = Array.from({ length: 1100 }, (_, i) => ['user', 'assistant'].map((type, j) => ({
   ...msg(type, `${type}-${i}`, `${type} ${i}`), timestamp: new Date(1_000 + i * 2000 + j * 1000).toISOString(),
 }))).flat();
 const h = new ClaudeHistory({ list: async () => [info], messages: async () => entries });
 await h.refresh(new Set()); const thread = await h.detail('claude-history-native-greeting', []);
 const detail = { thread }, state = createProjectedThreadStreamState(detail);
 const snapshot: any = projectedThreadBoundedSnapshot(state);
 const seen = new Set(snapshot.snapshot.thread.messages.map((m: any) => m.id));
 expect(seen.size).toBe(20);
 let cursor = snapshot.snapshot.historyPage.olderCursor;
 while (cursor) {
   const page = await readProjectedOlderPage(state, cursor, async () => detail, 10);
   expect(page.messages.length).toBeLessThanOrEqual(20);
   for (const m of page.messages) { expect(seen.has(m.id)).toBe(false); seen.add(m.id); }
   cursor = page.pageInfo.olderCursor;
 }
 expect(seen.size).toBe(2200); expect(seen.has('user-0')).toBe(true);
 expect(thread.activities.some((a: any) => a.id.startsWith('history-limit'))).toBe(false);
});

test('native history preserves public summaries and image references without inline image bytes', async () => {
 const root = mkdtempSync(join(tmpdir(), 'claude-history-images-'));
 try {
   const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
   const assistant = msg('assistant', 'a', [
     { type: 'thinking', thinking: 'Checking the page layout.' },
     { type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: '/workspace/GlinkBot/preview.png' } },
   ]);
   assistant.message.model = 'claude-sonnet-5-5';
   const history = new ClaudeHistory({ list: async () => [info], messages: async () => [
     msg('user', 'u', 'Check this image'), assistant,
     msg('user', 'r', [{ type: 'tool_result', tool_use_id: 'read-image', content: [
       { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
     ] }]),
   ] }, new ClaudeToolImages(root));
   await history.refresh(new Set()); const thread = await history.detail('claude-history-native-greeting', []);
   expect(thread.activities.find((a: any) => a.kind === 'claude.thinking-summary').payload.detail).toBe('Checking the page layout.');
   expect(thread.activities.find((a: any) => a.id === 'read-image').payload.data).toMatchObject({
     inputDetail: '/workspace/GlinkBot/preview.png', toolImages: [expect.stringContaining(root)],
   });
   expect(JSON.stringify(thread)).not.toContain(image);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discovers native projects without duplicate owned sessions, preserves timestamps and readable tools', async () => {
 let reads = 0;
 const reader: ClaudeHistoryReader = { list: async () => [info, { ...info, sessionId: 'owned' }], messages: async () => { reads++; return [
   msg('user', 'u', 'Read the file'), msg('assistant', 'a', [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/workspace/GlinkBot/a.txt' } }]),
   msg('user', 'r', [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: 'hello' }] }]), msg('assistant', 'b', 'Done'),
 ]; } };
 const h = new ClaudeHistory(reader); expect(await h.refresh(new Set(['owned']))).toBe(true);
 expect(h.shells([])).toHaveLength(1); const shell = h.shells([])[0]!;
 expect(shell.title).toBe('Greeting'); expect(shell.updatedAt).toBe('1970-01-01T00:00:02.000Z'); expect(h.projects([])[0]!.title).toBe('GlinkBot');
 const t = await h.detail(shell.id, []);
 expect(t.messages.map((m:any) => m.text)).toEqual(['Read the file', 'Reading.', 'Done']);
 expect(t.messages[0].createdAt).toBe('2026-10-14T00:00:00.000Z');
 expect(t.activities[0].payload).toMatchObject({ status: 'completed', detail: 'hello' });
 expect(t.activities.at(-1).payload).toMatchObject({ readOnly: true, status: 'history' });
 expect(t.hasPendingApprovals).toBe(false);
 expect((await h.detail(shell.id, [])).latestUserMessageAt).toBe(t.latestUserMessageAt); expect(reads).toBe(1);
 const projects = [{ id: 'saved-project', workspaceRoot: info.cwd }];
 expect(h.projects(projects)).toEqual([]); expect(h.shells(projects)[0]!.projectId).toBe('saved-project');
 expect((await h.detail(shell.id, projects)).projectId).toBe('saved-project');
});

test('refreshes changed history and removes vanished sessions without mutating transcripts', async () => {
 let entries = [info], calls = 0;
 const h = new ClaudeHistory({ list: async () => entries, messages: async () => { calls++; return [msg('user', 'u', 'Hello')]; } });
 await h.refresh(new Set()); await h.detail('claude-history-native-greeting', []);
 entries = [{ ...info, lastModified: 3000 }]; await h.refresh(new Set(), true); await h.detail('claude-history-native-greeting', []); expect(calls).toBe(2);
 entries = []; await h.refresh(new Set(), true); expect(h.shells([])).toEqual([]); expect(h.cachedDetail('claude-history-native-greeting')).toBeUndefined();
});

test('reads every metadata page and rejects oversized transcripts before loading', async () => {
 const entries = Array.from({length:201}, (_,i) => ({...info, sessionId: `native-${i}`, fileSize: 17 * 1024 * 1024})); let reads = 0;
 const h = new ClaudeHistory({ list: async (o) => entries.slice(o?.offset ?? 0, (o?.offset ?? 0) + (o?.limit ?? 200)), messages: async () => { reads++; return []; } });
 await h.refresh(new Set()); expect(h.shells([])).toHaveLength(201);
 await expect(h.detail('claude-history-native-0', [])).rejects.toThrow('too large'); expect(reads).toBe(0);
});

test('history hides CLI control messages while preserving prompts and tool results', async () => {
 const h = new ClaudeHistory({ list: async () => [info], messages: async () => [
   msg('user', 'prompt', 'Read the file'),
   msg('user', 'control', '<local-command-stdout>Set model to sonnet</local-command-stdout>'),
   { ...msg('user', 'meta', 'Internal context'), isMeta: true },
   msg('user', 'task-notice', '<task-notification>\n<task-id>bg-123</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<output-file>C:\\Temp\\private.output</output-file>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>\nRead the output file to retrieve the result.'),
   msg('user', 'task-killed', '<task-notification>\n<task-id>bg-456</task-id>\n<tool-use-id>tool-2</tool-use-id>\n<status>killed</status>\n<summary>Task was stopped by the user</summary>\n</task-notification>'),
   msg('assistant', 'tool', [{ type: 'tool_use', id: 'read', name: 'Read', input: {file_path:'/workspace/GlinkBot/a.txt'} }]),
   { ...msg('user', 'result', [{type:'tool_result',tool_use_id:'read',content:'File contents'}]), isSynthetic: true },
   msg('assistant', 'reply', 'Done'),
 ] });
 await h.refresh(new Set()); const t = await h.detail('claude-history-native-greeting', []);
 expect(t.messages.map((m: any) => m.text)).toEqual(['Read the file', 'Done']);
 expect(t.activities.find((a: any) => a.id === 'read').payload.status).toBe('completed');
 expect(t.messages[1].turnId).toBe(t.messages[0].turnId);
});

test('literal task-notification tags inside a human prompt remain visible', async () => {
 const prompt = 'Explain <task-notification><task-id>example</task-id><status>completed</status></task-notification> please';
 const h = new ClaudeHistory({ list: async () => [info], messages: async () => [msg('user', 'literal', prompt)] });
 await h.refresh(new Set());
 expect((await h.detail('claude-history-native-greeting', [])).messages[0].text).toBe(prompt);
});
