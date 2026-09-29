import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

export const ANDROID_ATTACHMENT_MAX_COUNT = 8;
export const ANDROID_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ANDROID_ATTACHMENT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const STAGED_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

export type StagedAndroidAttachments = {
  codexInputs: Array<{ type: "localImage"; path: string }>;
  referencedFiles: string[];
  stagedPaths: string[];
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function cleanFilename(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? basename(value.trim()) : "";
  const cleaned = raw.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned || fallback;
}

function decodeDataUrl(value: unknown): { mimeType: string; bytes: Buffer } {
  if (typeof value !== "string") throw new TypeError("attachment data is missing");
  const match = /^data:([^;,]{1,100});base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new TypeError("attachment must use a base64 data URL");
  const bytes = Buffer.from(match[2]!.replace(/[\r\n]/g, ""), "base64");
  if (bytes.length === 0 || bytes.length > ANDROID_ATTACHMENT_MAX_BYTES) {
    throw new RangeError("attachment exceeds the 10 MB limit");
  }
  return { mimeType: match[1]!.toLowerCase(), bytes };
}

function isSupportedImage(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function ensureFolder(path: string): void {
  assertNotRealHomeUnderTest(path);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform === "win32") hardenSecretDir(path, { required: false });
}

export function androidAttachmentRoot(root = getConfigDir()): string {
  return join(root, "android-remote-files");
}

/**
 * Stages phone-owned attachment bytes under Remodex's protected data folder.
 * Images become native Codex localImage inputs. Other file types are supported
 * by the gateway contract and are added to the prompt as explicit PC-local paths.
 */
export function stageAndroidAttachments(input: {
  clientId: string;
  attachments: unknown;
  root?: string;
}): StagedAndroidAttachments {
  if (!Array.isArray(input.attachments)) throw new TypeError("attachments must be an array");
  if (input.attachments.length > ANDROID_ATTACHMENT_MAX_COUNT) {
    throw new RangeError(`a prompt can contain at most ${ANDROID_ATTACHMENT_MAX_COUNT} attachments`);
  }
  const root = androidAttachmentRoot(input.root);
  const clientFolder = join(root, input.clientId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const turnFolder = join(clientFolder, randomUUID());
  ensureFolder(turnFolder);

  const codexInputs: StagedAndroidAttachments["codexInputs"] = [];
  const referencedFiles: string[] = [];
  const stagedPaths: string[] = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < input.attachments.length; index += 1) {
      const attachment = record(input.attachments[index]);
      if (!attachment || (attachment.type !== "image" && attachment.type !== "file")) {
        throw new TypeError("unsupported Android attachment type");
      }
      const decoded = decodeDataUrl(attachment.dataUrl);
      const declaredMime = typeof attachment.mimeType === "string"
        ? attachment.mimeType.trim().toLowerCase()
        : decoded.mimeType;
      if (declaredMime !== decoded.mimeType) throw new TypeError("attachment media type does not match its data");
      if (attachment.type === "image" && !declaredMime.startsWith("image/")) {
        throw new TypeError("image attachment must use an image media type");
      }
      if (attachment.type === "image" && !isSupportedImage(declaredMime, decoded.bytes)) {
        throw new TypeError("image attachment must be a valid PNG, JPEG, GIF, or WebP file");
      }
      if (typeof attachment.sizeBytes === "number"
        && Number.isFinite(attachment.sizeBytes)
        && Math.abs(attachment.sizeBytes - decoded.bytes.length) > 3) {
        throw new TypeError("attachment size does not match its data");
      }
      totalBytes += decoded.bytes.length;
      if (totalBytes > ANDROID_ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new RangeError("combined attachments exceed the 40 MB limit");
      }
      const originalName = cleanFilename(attachment.name, `attachment-${index + 1}`);
      const extension = extname(originalName).slice(0, 20);
      const stem = basename(originalName, extension).slice(0, 120) || `attachment-${index + 1}`;
      const path = join(turnFolder, `${stem}-${randomUUID()}${extension}`);
      writeFileSync(path, decoded.bytes, { mode: 0o600, flag: "wx" });
      try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
      stagedPaths.push(path);
      if (attachment.type === "image") codexInputs.push({ type: "localImage", path });
      else referencedFiles.push(path);
    }
    return { codexInputs, referencedFiles, stagedPaths };
  } catch (error) {
    try { rmSync(turnFolder, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
    throw error;
  }
}

export function sweepOldAndroidAttachments(
  root = androidAttachmentRoot(),
  now = Date.now(),
): void {
  try {
    if (!existsSync(root)) return;
    for (const client of readdirSync(root, { withFileTypes: true })) {
      if (!client.isDirectory()) continue;
      const clientPath = join(root, client.name);
      for (const turn of readdirSync(clientPath, { withFileTypes: true })) {
        if (!turn.isDirectory()) continue;
        const turnPath = join(clientPath, turn.name);
        if (now - statSync(turnPath).mtimeMs > STAGED_FILE_TTL_MS) {
          rmSync(turnPath, { recursive: true, force: true });
        }
      }
    }
  } catch {
    // Attachment cleanup is maintenance. A locked file must not stop the gateway.
  }
}
