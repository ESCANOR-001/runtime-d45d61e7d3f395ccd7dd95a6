import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToolImages } from '../src/claude-code/tool-images';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('captures native and MCP image results once, scoped to their chat', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-images-')); roots.push(root); const images = new ClaudeToolImages(root);
  const native = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
  const mcp = { type: 'image', mimeType: 'image/png', data: png };
  const paths = images.capture('one', [native, mcp]); expect(paths).toHaveLength(1);
  expect(readFileSync(paths[0]!).toString('base64')).toBe(png);
  expect(images.capture('one', { content: [mcp] })).toEqual(paths);
  expect(images.capture('two', native)[0]).not.toBe(paths[0]);
  expect(images.capture('one', { type: 'resource', resource: { mimeType: 'image/png', blob: png } })).toEqual(paths);
});
test('does not fetch URLs, trust arbitrary paths, or accept disguised/non-image/oversized data', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-images-')); roots.push(root); const images = new ClaudeToolImages(root);
  expect(images.capture('one', [
    { type: 'image', source: { type: 'url', url: 'http://127.0.0.1/private' } },
    { type: 'text', text: '/tmp/secret.png' },
    { type: 'image', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') },
    { type: 'image', mimeType: 'image/svg+xml', data: png },
    { type: 'image', mimeType: '__proto__', data: Buffer.from('RIFF0000WEBP').toString('base64') },
    { type: 'image', mimeType: 'image/png', data: 'a'.repeat(24 * 1024 * 1024) },
  ])).toEqual([]);
});
