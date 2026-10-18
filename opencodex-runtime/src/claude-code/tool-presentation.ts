import { isAbsolute, relative, sep } from 'node:path';
type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const LIMIT = 64_000;

/** Render content blocks without leaking image/document bytes into the transcript. */
export function claudeToolText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value.slice(0, LIMIT);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => claudeToolText(v, depth + 1)).filter(Boolean).join('\n').slice(0, LIMIT);
  const v = row(value);
  if (v.type === 'text') return text(v.text).slice(0, LIMIT);
  if (v.type === 'tool_reference') return `Tool available: ${text(v.tool_name)}`;
  if (v.type === 'image') return 'Image returned by tool';
  if (v.type === 'document') return text(v.title) || 'Document returned by tool';
  if (v.type === 'resource_link') return [text(v.name) || 'Resource', text(v.uri)].filter(Boolean).join(': ');
  if (v.type === 'resource') return claudeToolText(v.resource, depth + 1);
  return Object.entries(v).slice(0, 60)
    .filter(([key]) => !['source', 'data', 'base64', 'blob', 'originalFile', 'structuredPatch'].includes(key))
    .map(([key, item]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2')}: ${claudeToolText(item, depth + 1)}`)
    .join('\n').slice(0, LIMIT);
}

export function claudeToolInput(name: string, input: Row): string {
  if (name === 'Bash') return text(input.command);
  if (name === 'Read') return text(input.file_path);
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return text(input.file_path);
  if (name === 'ToolSearch') return text(input.query);
  if (name === 'Grep' || name === 'Glob') return [text(input.pattern), text(input.path)].filter(Boolean).join('\n');
  if (name === 'WebSearch') return text(input.query);
  if (name === 'WebFetch') return text(input.url);
  return claudeToolText(input);
}

/** Only actual successful tool results can establish a file change. Never diff current disk state. */
export function claudeFileChange(name: string, value: unknown, cwd?: string) {
  const output = row(value);
  if (!['Write', 'Edit', 'MultiEdit'].includes(name) || output.staged === true || !text(output.filePath)) return undefined;
  const absolute = text(output.filePath);
  const local = cwd && isAbsolute(absolute) ? relative(cwd, absolute) : absolute;
  const path = local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) ? local.split(sep).join('/') : absolute;
  let hunks = Array.isArray(output.structuredPatch) ? output.structuredPatch : [];
  // The CLI can omit hunks for newly created files. Their exact contents are still authoritative.
  if (!hunks.length && name === 'Write' && output.type === 'create' && typeof output.content === 'string') {
    const lines = output.content === '' ? [] : output.content.split('\n');
    if (output.content.endsWith('\n')) lines.pop();
    hunks = [{ oldStart: 0, oldLines: 0, newStart: lines.length ? 1 : 0, newLines: lines.length,
      lines: [...lines.map((line: string) => `+${line}`), ...(lines.length && !output.content.endsWith('\n') ? ['\\ No newline at end of file'] : [])] }];
  }
  let additions = 0; let deletions = 0; let truncated = false;
  const quote = (p: string) => /[\s"\\]/.test(p) ? JSON.stringify(p) : p;
  let diff = `--- ${output.type === 'create' ? '/dev/null' : quote(`a/${path}`)}\n+++ ${quote(`b/${path}`)}\n`;
  let validHunks = 0;
  for (const raw of hunks) {
    const h = row(raw);
    if (![h.oldStart, h.oldLines, h.newStart, h.newLines].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Array.isArray(h.lines) || !h.lines.every((l: unknown) => typeof l === 'string' && /^(?:[ +\-]|\\ No newline)/.test(l))) continue;
    validHunks++;
    const lines = [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines];
    for (const line of h.lines as string[]) { if (line.startsWith('+')) additions++; if (line.startsWith('-')) deletions++; }
    for (const line of lines) {
      if (truncated || diff.length + line.length + 1 > LIMIT) { truncated = true; continue; }
      diff += `${line}\n`;
    }
  }
  return { path, additions, deletions, ...(validHunks ? { diff: diff.replace(/\n$/, ''), ...(truncated ? { diffTruncated: true } : {}) } : {}) };
}

export function claudeToolResult(name: string, content: unknown, structured: unknown): string {
  const output = row(structured);
  if (output.staged === true) return 'Proposed change is waiting for review; the file has not changed.';
  if (name === 'Bash' && (typeof output.stdout === 'string' || typeof output.stderr === 'string')) {
    return [text(output.stdout), text(output.stderr)].filter(Boolean).join('\n').slice(0, LIMIT);
  }
  return claudeToolText(content);
}
