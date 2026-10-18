import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/** Bind a restore preview to the exact files the user reviewed. No native state is edited. */
export async function restoreFingerprint(cwd: string, files: string[]): Promise<string> {
  if (files.length > 100) throw new Error('This restore affects more than 100 files. Review it on the PC.');
  const root = await realpath(cwd);
  const hash = createHash('sha256');
  for (const name of [...files].sort()) {
    const path = resolve(root, name), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('This restore includes files outside the project. Review it on the PC.');
    const parent = relative(root, await realpath(dirname(path)));
    if (parent.startsWith('..') || isAbsolute(parent)) throw new Error('A restore path points outside the project.');
    const info = await lstat(path).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    hash.update(path); hash.update('\0');
    if (!info) { hash.update('missing'); continue; }
    if (!info.isFile() || info.nlink > 1 || info.size > 16 * 1024 * 1024) throw new Error('A restore file cannot be safely previewed. Review it on the PC.');
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

export async function claudeGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', error = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 30_000);
    child.stdout.on('data', b => { out += b; if (out.length > 64_000) { exceeded = true; child.kill(); } });
    child.stderr.on('data', b => { error = (error + b).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (code || exceeded) reject(new Error(exceeded ? 'Git did not finish creating the worktree.' : error.trim() || 'Git operation failed.')); else resolve(out.trim()); });
  });
}

/** A separate checkout of the committed HEAD. Never switches or cleans the source checkout. */
export async function createClaudeWorktree(cwd: string, storage: string) {
  const repo = await claudeGit(cwd, ['rev-parse', '--show-toplevel']);
  const head = await claudeGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const id = randomUUID(), branch = `remodex/claude-${id.slice(0, 12)}`;
  const path = join(storage, 'worktrees', id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await claudeGit(repo, ['worktree', 'add', '-b', branch, path, head]);
  return { path, branch, head };
}
