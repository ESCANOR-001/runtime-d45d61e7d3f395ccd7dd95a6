import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchProjectFolders } from '../src/android-remote/folder-search';
import { AndroidRemoteGatewayController } from '../src/android-remote/gateway';

test('folder picker accepts full directory and file paths without changing legacy path completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folder-browse-'));
  const controller = Object.create(AndroidRemoteGatewayController.prototype) as any;
  try {
    await mkdir(join(root, 'Project'));
    await writeFile(join(root, 'Project', 'README.md'), 'not returned');
    const folder = await controller.browseFilesystem({ partialPath: join(root, 'Project'), resolvePath: true });
    const file = await controller.browseFilesystem({ partialPath: join(root, 'Project', 'README.md'), resolvePath: true });
    expect(folder.parentPath).toBe(await realpath(join(root, 'Project')));
    expect(file.parentPath).toBe(folder.parentPath);
    expect(file.entries).toEqual([]);
    const legacy = await controller.browseFilesystem({ partialPath: join(root, 'Pro') });
    expect(legacy.entries[0].name).toBe('Project');
    await expect(controller.browseFilesystem({ partialPath: join(root, 'missing'), resolvePath: true })).rejects.toThrow('does not exist');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('name search finds nested files and folders without reading file content or following loops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folder-search-'));
  try {
    await mkdir(join(root, 'GlinkBot', 'docs'), { recursive: true });
    await writeFile(join(root, 'GlinkBot', 'docs', 'glink-notes.md'), 'private content');
    await mkdir(join(root, 'node_modules', 'glink-generated'), { recursive: true });
    if (process.platform !== 'win32') await symlink(root, join(root, 'GlinkBot', 'loop'));
    const result = await searchProjectFolders([root, root], 'GLINK');
    expect(result.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['glink-notes.md', 'file'], ['GlinkBot', 'directory'],
    ]);
    expect(JSON.stringify(result)).not.toContain('private content');
    expect(result.truncated).toBe(false);
    expect((await searchProjectFolders([root], 'glink', { matches: 1 })).truncated).toBe(true);
    expect((await searchProjectFolders([root], 'missing', { entries: 1 })).truncated).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
