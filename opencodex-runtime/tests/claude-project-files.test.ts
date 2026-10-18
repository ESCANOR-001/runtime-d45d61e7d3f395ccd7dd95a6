import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeGit } from '../src/claude-code/session-files';
import { claudeProjectRoot, claudeProjectEntries, claudeProjectFile, claudeProjectDiff } from '../src/claude-code/project-files';

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'claude-files-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('Claude files use its project and worktree roots without borrowing Codex access', async () => {
  const root = fixture(), worktree = fixture(), outside = fixture();
  const shell = { projects: [{ workspaceRoot: root }], threads: [{ worktreePath: worktree }] };
  expect(await claudeProjectRoot(root, shell)).toBe(realpathSync(root));
  expect(await claudeProjectRoot(worktree, shell)).toBe(realpathSync(worktree));
  await expect(claudeProjectRoot(outside, shell)).rejects.toThrow('not part of a Claude task');
  writeFileSync(join(outside, 'private.txt'), 'outside');
  await expect(claudeProjectFile(root, join(outside, 'private.txt'))).rejects.toThrow('project folder');
});

test('Claude file listing, search and reading work without a Codex connection', async () => {
  const root = fixture(); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'src', 'notes.txt'), 'Realme fixture');
  writeFileSync(join(root, 'node_modules', 'notes.txt'), 'ignored');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  expect((await claudeProjectEntries(root)).entries).toEqual([{ path: 'src', kind: 'directory' }, { path: 'binary.bin', kind: 'file' }, { path: 'src/notes.txt', kind: 'file' }]);
  expect((await claudeProjectEntries(root, 'notes', 80)).entries).toEqual([{ path: 'src', kind: 'directory' }, { path: 'src/notes.txt', kind: 'file' }]);
  expect(await claudeProjectEntries(root, 'notes', 1)).toEqual({ entries: [], truncated: true });
  expect(await claudeProjectFile(root, 'src/notes.txt')).toMatchObject({ contents: 'Realme fixture', truncated: false });
  await expect(claudeProjectFile(root, 'binary.bin')).rejects.toThrow('binary');
});

test('Claude file search does not follow a linked folder outside the project', async () => {
  const root = fixture(), outside = fixture();
  writeFileSync(join(outside, 'private-notes.txt'), 'outside');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await claudeProjectEntries(root, 'notes')).entries).toEqual([]);
  await expect(claudeProjectFile(root, 'linked/private-notes.txt')).rejects.toThrow('project folder');
});

test('Claude Changes includes tracked and new files while leaving the project untouched', async () => {
  const root = fixture(); await claudeGit(root, ['init']);
  writeFileSync(join(root, 'notes.txt'), 'before\n');
  await claudeGit(root, ['add', 'notes.txt']);
  await claudeGit(root, ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-m', 'fixture']);
  writeFileSync(join(root, 'notes.txt'), 'after\n');
  writeFileSync(join(root, 'new.txt'), 'new file\n');
  const before = await claudeGit(root, ['status', '--porcelain']);
  const result = await claudeProjectDiff(root, false);
  expect(result.sources[0]!.diff).toContain('-before');
  expect(result.sources[0]!.diff).toContain('+after');
  expect(result.sources[0]!.diff).toContain('+new file');
  expect(await claudeGit(root, ['status', '--porcelain'])).toBe(before);
});

test('a Claude project inside a larger repository only previews its own changes', async () => {
  const root = fixture(), project = join(root, 'project'); mkdirSync(project);
  await claudeGit(root, ['init']);
  writeFileSync(join(root, 'outside.txt'), 'outside before\n');
  writeFileSync(join(project, 'inside.txt'), 'inside before\n');
  await claudeGit(root, ['add', '.']);
  await claudeGit(root, ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-m', 'fixture']);
  writeFileSync(join(root, 'outside.txt'), 'outside private edit\n');
  writeFileSync(join(project, 'inside.txt'), 'inside after\n');
  writeFileSync(join(project, 'new.txt'), 'new inside\n');
  const diff = (await claudeProjectDiff(project, false)).sources[0]!.diff;
  expect(diff).toContain('+inside after'); expect(diff).toContain('+new inside');
  expect(diff).not.toContain('outside private edit'); expect(diff).not.toContain('outside.txt');
});

test('Claude file listing and new-file changes accept a project reached through a directory alias', async () => {
  const root = fixture(), links = fixture(), alias = join(links, 'project');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await claudeGit(root, ['init']);
  writeFileSync(join(root, 'new.txt'), 'new through alias\n');
  const shell = { projects: [{ workspaceRoot: alias }], threads: [] };
  expect(await claudeProjectRoot(alias, shell)).toBe(realpathSync(root));
  expect((await claudeProjectEntries(alias)).entries).toEqual([{ path: 'new.txt', kind: 'file' }]);
  const diff = (await claudeProjectDiff(alias, false)).sources[0]!.diff;
  expect(diff).toContain('+new through alias');
});
