import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Row = Record<string, any>;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 8;
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Keep tool-returned bytes on the PC. Only bounded, exact-file references enter snapshots. */
export class ClaudeToolImages {
  constructor(private root: string) {}

  capture(threadId: string, content: unknown): string[] {
    const images: string[] = [];
    let remaining = MAX_BYTES;
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 6 || remaining <= 0 || images.length >= MAX_IMAGES || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach(v => visit(v, depth + 1)); return; }
      const block = value as Row;
      const source = block.type === 'image' ? block.source : undefined;
      const mime = source?.type === 'base64' ? source.media_type : block.mimeType;
      const data = source?.type === 'base64' ? source.data
        : block.type === 'image' ? block.data : block.blob;
      const ext = typeof mime === 'string' && Object.hasOwn(extensions, mime) ? extensions[mime] : undefined;
      if (ext && typeof data === 'string' && data.length > 0 && data.length <= Math.ceil(remaining / 3) * 4 &&
          data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        const bytes = Buffer.from(data, 'base64');
        const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : ext === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
        if (!valid || !bytes.length || bytes.length > remaining) return;
        const directory = join(this.root, createHash('sha256').update(threadId).digest('hex'));
        const path = resolve(directory, `${createHash('sha256').update(bytes).digest('hex')}.${ext}`);
        try {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          if (!images.includes(path)) images.push(path);
          remaining -= bytes.length;
        } catch { /* A preview must never fail the tool or replay a task. */ }
        return;
      }
      // Only content containers, never arbitrary tool input, URLs, or filesystem paths.
      for (const key of ['content', 'resource']) visit(block[key], depth + 1);
    };
    visit(content);
    return images;
  }
}
