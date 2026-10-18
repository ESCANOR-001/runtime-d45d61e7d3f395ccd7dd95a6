import { expect, test } from 'bun:test';
import { claudeFileChange, claudeToolText, claudeToolInput, claudeToolResult } from '../src/claude-code/tool-presentation';

test('renders nested tool text and references without binary payloads', () => {
  expect(claudeToolText([{ type: 'text', text: 'Result' }, { type: 'tool_reference', tool_name: 'Read' }, { type: 'image', source: { data: 'SECRET_BINARY' } }]))
    .toBe('Result\nTool available: Read\nImage returned by tool');
  expect(claudeToolText({ result: { items: [{ title: 'Found', url: 'https://example.com' }] } })).toContain('title: Found');
  expect(claudeToolText({ blob: 'SECRET_BINARY', source: 'SECRET_BINARY', text: 'Visible' })).not.toContain('SECRET_BINARY');
  expect(claudeToolInput('Grep', { pattern: 'hello', path: '/work' })).toBe('hello\n/work');
  expect(claudeToolResult('Bash', 'wrapped output', { stdout: 'out', stderr: 'err' })).toBe('out\nerr');
});
test('preserves actual edit hunks and counts with original line numbers', () => {
  const change = claudeFileChange('Edit', { filePath: '/work/a.txt', structuredPatch: [
    { oldStart: 8, oldLines: 2, newStart: 8, newLines: 3, lines: [' context', '-old', '+new', '+extra'] },
    { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ['-last', '+end'] },
  ] });
  expect(change).toMatchObject({ path: '/work/a.txt', additions: 3, deletions: 2 });
  expect(change?.diff).toContain('@@ -8,2 +8,3 @@\n context\n-old\n+new\n+extra');
  expect(change?.diff).toContain('@@ -20,1 +21,1 @@');
});
test('creation fallback is exact and never invents a replacement diff', () => {
  expect(claudeFileChange('Write', { filePath: '/work/a.txt', type: 'create', content: 'one\ntwo\n' }))
    .toMatchObject({ additions: 2, deletions: 0, diff: '--- /dev/null\n+++ b//work/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two' });
  expect(claudeFileChange('Write', { filePath: '/work/a.txt', type: 'update', content: 'new', originalFile: null })?.diff).toBeUndefined();
  expect(claudeFileChange('Write', { filePath: '/work/a.txt', type: 'create', content: 'one' })?.diff).toContain('\\ No newline at end of file');
  expect(claudeFileChange('Write', { filePath: '/work/a.txt', staged: true })).toBeUndefined();
  expect(claudeFileChange('Bash', { filePath: '/work/a.txt' })).toBeUndefined();
});
test('bounds huge diffs at a line boundary while preserving total stats', () => {
  const change = claudeFileChange('Write', { filePath: 'large.txt', type: 'create', content: ('x'.repeat(100) + '\n').repeat(2000) });
  expect(change?.additions).toBe(2000);
  expect(change?.diffTruncated).toBe(true);
  expect(change!.diff!.length).toBeLessThanOrEqual(64_000);
  expect(change!.diff!.split('\n').at(-1)).toBe('+' + 'x'.repeat(100));
});

test('shows workspace-relative filenames while preserving paths outside the workspace', () => {
  const result = { type: 'create', filePath: '/work/src/demo.txt', content: 'ok\n' };
  expect(claudeFileChange('Write', result, '/work')).toMatchObject({ path: 'src/demo.txt', diff: '--- /dev/null\n+++ b/src/demo.txt\n@@ -0,0 +1,1 @@\n+ok' });
  expect(claudeFileChange('Write', result, '/other')?.path).toBe('/work/src/demo.txt');
});
