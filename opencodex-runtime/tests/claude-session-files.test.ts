import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeGit, createClaudeWorktree, restoreFingerprint } from '../src/claude-code/session-files';

test('isolated worktrees preserve source branch and dirty files and contain only committed content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-worktree-'));
  try {
    await claudeGit(root, ['init']);
    await writeFile(join(root, 'note.txt'), 'committed');
    await claudeGit(root, ['add', 'note.txt']);
    await claudeGit(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture']);
    const branch = await claudeGit(root, ['branch', '--show-current']);
    await writeFile(join(root, 'note.txt'), 'uncommitted');
    const tree = await createClaudeWorktree(root, join(root, '.state'));
    expect(await readFile(join(tree.path, 'note.txt'), 'utf8')).toBe('committed');
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('uncommitted');
    expect(await claudeGit(root, ['branch', '--show-current'])).toBe(branch);
    expect(await claudeGit(tree.path, ['branch', '--show-current'])).toBe(tree.branch);
    expect(tree.branch).toStartWith('remodex/claude-');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('restore previews reject outside paths and linked files and detect content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-restore-'));
  try {
    await writeFile(join(root, 'note'), 'before');
    const before = await restoreFingerprint(root, ['note']);
    await writeFile(join(root, 'note'), 'after');
    expect(await restoreFingerprint(root, ['note'])).not.toBe(before);
    await expect(restoreFingerprint(root, ['../outside'])).rejects.toThrow('outside');
    if (process.platform !== 'win32') {
      await symlink(join(root, 'note'), join(root, 'linked'));
      await expect(restoreFingerprint(root, ['linked'])).rejects.toThrow('safely');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
