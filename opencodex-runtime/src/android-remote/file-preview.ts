import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PREVIEW_BYTES = 256 * 1024;

export async function readWorkspaceTextFile(workspaceRoot: string, requestedPath: string) {
  if (!requestedPath.trim() || requestedPath.length > 4096 || requestedPath.includes("\0")) {
    throw new TypeError("A valid file path is required.");
  }
  const root = await realpath(workspaceRoot);
  const resolved = resolve(root, requestedPath);
  const requestedChild = relative(root, resolved);
  if (requestedChild === ".." || requestedChild.startsWith(`..${sep}`) || isAbsolute(requestedChild)) {
    throw new TypeError("File previews are limited to this task’s project folder.");
  }
  const path = await realpath(resolved);
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new TypeError("File previews are limited to this task’s project folder.");
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new TypeError("This path is not a regular text file.");
    const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > PREVIEW_BYTES;
    const bytes = buffer.subarray(0, Math.min(bytesRead, PREVIEW_BYTES));
    if (bytes.includes(0)) throw new TypeError("This is a binary file, not a text file.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      throw new TypeError("This file is not UTF-8 text and cannot be previewed.");
    }
    return { path: child, content, truncated, sizeBytes: metadata.size };
  } finally {
    await file.close();
  }
}
