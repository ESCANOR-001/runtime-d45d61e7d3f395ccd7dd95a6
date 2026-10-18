import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readWorkspaceTextFile } from '../android-remote/file-preview';

type Row = Record<string, any>;
const hidden = new Set(['.git', '.hg', '.svn', 'node_modules']);
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Only folders already exposed by this Claude connection may be inspected. */
export async function claudeProjectRoot(cwd: unknown, shell: Row): Promise<string> {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096 || cwd.includes('\0')) throw new TypeError('Select a Claude project folder.');
  const roots = [...shell.projects.map((p: Row) => p.workspaceRoot), ...shell.threads.map((t: Row) => t.worktreePath)];
  const root = roots.find(path => typeof path === 'string' && key(path) === key(cwd));
  if (!root) throw new TypeError('This folder is not part of a Claude task visible on this phone.');
  return realpath(root);
}

export async function claudeProjectEntries(cwd: string, query?: unknown, requestedLimit?: unknown) {
  // macOS /var and Windows junctions can name the same project through an
  // alias. Compare every child against the same canonical root.
  cwd = await realpath(cwd);
  const search = query === undefined ? null : typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (search !== null && (!search || search.length > 256)) throw new TypeError('Enter a file search of 1 to 256 characters.');
  const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 200;
  const entries: Array<{ path: string; kind: 'file' | 'directory' }> = [];
  const included = new Set<string>();
  const pending = ['']; let visited = 0, truncated = false;
  while (pending.length) {
    const directory = pending.shift()!;
    let children;
    try {
      const canonical = await realpath(join(cwd, directory));
      const childPath = relative(cwd, canonical);
      if (isAbsolute(childPath) || childPath === '..' || childPath.startsWith('../') || childPath.startsWith('..\\')) continue;
      children = await readdir(canonical, { withFileTypes: true });
    }
    catch (error) { if (!directory) throw error; continue; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (++visited > 5000) { truncated = true; break; }
      if (hidden.has(child.name) || child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) continue;
      const path = directory ? `${directory}/${child.name}` : child.name;
      if (child.isDirectory()) pending.push(path);
      if (search && !path.toLowerCase().includes(search)) continue;
      // The phone renders a tree, so matching nested files need their parent
      // rows as well. Keep the whole response (including parents) bounded.
      const parts = path.split('/');
      const additions: typeof entries = [];
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join('/');
        if (!included.has(parent)) additions.push({ path: parent, kind: 'directory' });
      }
      if (!included.has(path)) additions.push({ path, kind: child.isDirectory() ? 'directory' : 'file' });
      if (entries.length + additions.length > limit) { truncated = true; break; }
      for (const entry of additions) { entries.push(entry); included.add(entry.path); }
    }
    if (truncated) break;
  }
  entries.sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1);
  return { entries, truncated };
}

export async function claudeProjectFile(cwd: string, requestedPath: unknown) {
  if (typeof requestedPath !== 'string') throw new TypeError('Select a text file.');
  const file = await readWorkspaceTextFile(cwd, requestedPath);
  return { relativePath: file.path, contents: file.content, byteLength: file.sizeBytes, truncated: file.truncated };
}

function git(cwd: string, args: string[], allowed = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    let output = '', error = '', limited = false;
    const timer = setTimeout(() => { limited = true; child.kill(); }, 20_000);
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) { limited = true; child.kill(); } });
    child.stderr.on('data', data => { error = (error + data).slice(-1000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (limited) reject(new Error('These changes are too large to preview on the phone. Review them on the PC.'));
      else if (code === null || !allowed.includes(code)) reject(new Error(error.trim() || 'Could not read this project’s changes.'));
      else resolve(output);
    });
  });
}

export async function claudeProjectDiff(cwd: string, ignoreWhitespace: boolean) {
  cwd = await realpath(cwd);
  // No shell, external diff program, text conversion, index writes or checkout.
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', ...(ignoreWhitespace ? ['--ignore-all-space'] : [])];
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  let diff = hasHead ? await git(cwd, ['diff', '--relative', ...options, 'HEAD', '--', '.'])
    : await git(cwd, ['diff', '--relative', ...options, '--cached', '--', '.']) + await git(cwd, ['diff', '--relative', ...options, '--', '.']);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0').filter(Boolean);
  let truncated = untracked.length > 100;
  for (const name of untracked.slice(0, 100)) {
    const child = relative(cwd, await realpath(join(cwd, name)));
    if (isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) continue;
    const addition = await git(cwd, ['diff', '--no-index', ...options, '--', '/dev/null', name], [0, 1]);
    if (diff.length + addition.length > 1024 * 1024) { truncated = true; break; }
    diff += addition;
  }
  return { cwd, generatedAt: new Date().toISOString(), sources: [{ id: 'working-tree', kind: 'working-tree', title: 'Uncommitted changes', baseRef: hasHead ? 'HEAD' : null, headRef: null, diff, diffHash: createHash('sha256').update(diff).digest('hex'), truncated }] };
}
