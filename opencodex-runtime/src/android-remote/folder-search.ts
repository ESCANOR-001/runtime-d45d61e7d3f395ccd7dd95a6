import { opendir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

type Match = { name: string; fullPath: string; kind: 'file' | 'directory' };
// Do not walk generated dependency trees, virtual filesystems or OS caches.
const skipped = new Set(['node_modules', '.git', '.gradle', '.cache', '.npm', '.bun',
  '.pnpm-store', '__pycache__', '$recycle.bin', 'system volume information']);
const systemRoots = new Set(['/proc', '/sys', '/dev', '/run', '/usr', '/lib', '/lib64', '/bin', '/sbin']);

/** Bounded, read-only name search. No content reads, symlink traversal or persistent index. */
export async function searchProjectFolders(roots: readonly string[], query: string,
  limits: { entries?: number; matches?: number; milliseconds?: number } = {}) {
  const maxEntries = limits.entries ?? 60_000;
  const maxMatches = limits.matches ?? 100;
  const deadline = Date.now() + (limits.milliseconds ?? 4_000);
  const queue = [...new Set(roots.map(root => resolve(root)))];
  const seen = new Set<string>();
  const entries: Match[] = [];
  const needle = query.toLocaleLowerCase();
  let inspected = 0;
  let cursor = 0;
  let truncated = false;
  while (cursor < queue.length) {
    if (Date.now() >= deadline || inspected >= maxEntries || entries.length >= maxMatches) {
      truncated = true; break;
    }
    const path = queue[cursor++]!;
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++inspected > maxEntries || Date.now() >= deadline || entries.length >= maxMatches) {
          truncated = true; break;
        }
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const fullPath = join(path, entry.name);
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          entries.push({ name: entry.name, fullPath, kind: entry.isDirectory() ? 'directory' : 'file' });
        }
        if (entry.isDirectory() && !skipped.has(entry.name.toLowerCase()) && !systemRoots.has(fullPath)) {
          queue.push(fullPath);
        }
      }
    } catch { /* Unreadable/deleted folders do not end the search. */ }
    if (truncated) break;
  }
  entries.sort((a, b) => Number(!basename(a.fullPath).toLowerCase().startsWith(needle)) -
    Number(!basename(b.fullPath).toLowerCase().startsWith(needle)) ||
    a.name.localeCompare(b.name) || a.fullPath.localeCompare(b.fullPath));
  return { entries, truncated };
}
