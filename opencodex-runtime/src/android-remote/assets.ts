import { Buffer } from "node:buffer";
import sharp from "sharp";

import { randomBytes } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

sharp.concurrency(1);
sharp.cache({ memory: 16, items: 16, files: 0 });

const ANDROID_ASSET_TTL_MS = 60 * 60 * 1_000;
const ANDROID_ASSET_MAX_BYTES = 40 * 1024 * 1024;
const ANDROID_ASSET_MAX_TICKETS = 512;
const ANDROID_ASSET_ROUTE_PREFIX = "/api/android-remote/assets/";

type AndroidImageAsset = {
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly expiresAt: number;
};

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathIsWithinRoot(root: string, candidate: string): boolean {
  const child = relative(comparablePath(root), comparablePath(candidate));
  return child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

async function imageMimeType(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    if (
      header.length >= 8
      && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) return "image/png";
    if (
      header.length >= 3
      && header[0] === 0xff
      && header[1] === 0xd8
      && header[2] === 0xff
    ) return "image/jpeg";
    const ascii6 = header.subarray(0, 6).toString("ascii");
    if (ascii6 === "GIF87a" || ascii6 === "GIF89a") return "image/gif";
    if (
      header.length >= 12
      && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "image/webp";
    if (header.length >= 2 && header.subarray(0, 2).toString("ascii") === "BM") {
      return "image/bmp";
    }
    return null;
  } finally {
    await handle.close();
  }
}

function assetTokenFromPathname(pathname: string): string | null {
  const remainder = pathname.slice(ANDROID_ASSET_ROUTE_PREFIX.length);
  const token = remainder.split("/", 1)[0] ?? "";
  return /^[a-zA-Z0-9_-]{32,128}$/.test(token) ? token : null;
}

/**
 * Process-local, exact-file capabilities for Android image previews.
 *
 * Coil cannot attach the Android Remote bearer to a later image request, so
 * the WebSocket RPC returns a short-lived opaque URL. The capability is bound
 * to one canonical regular image inside the selected task's canonical root;
 * no caller-controlled path is accepted by the HTTP route.
 */
export class AndroidRemoteAssetStore {
  private readonly tickets = new Map<string, AndroidImageAsset>();
  private thumbnailQueue: Promise<unknown> = Promise.resolve();
  private readonly thumbnails = new Map<string, Promise<Buffer>>();

  constructor(private readonly now: () => number = Date.now) {}

  async issueWorkspaceImage(input: {
    readonly workspaceRoot: string;
    readonly path: string;
  }): Promise<{ readonly relativeUrl: string; readonly expiresAt: number }> {
    const workspaceRoot = input.workspaceRoot.trim();
    const requestedPath = input.path.trim();
    if (!workspaceRoot) throw new TypeError("The selected Codex task has no project folder");
    if (!requestedPath) throw new TypeError("Image path is required");
    if (requestedPath.length > 32 * 1024) throw new RangeError("Image path is too long");

    const canonicalRoot = await realpath(resolve(workspaceRoot));
    const unresolvedFile = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(canonicalRoot, requestedPath);
    const canonicalFile = await realpath(unresolvedFile);
    if (!pathIsWithinRoot(canonicalRoot, canonicalFile)) {
      throw new TypeError("Image must be inside the selected Codex project folder");
    }

    return this.issueCanonicalImage(canonicalFile);
  }

  /**
   * Issues an exact-file capability after the gateway has verified that the
   * assistant explicitly referenced this absolute image in the selected task.
   * Keeping that authorization in the gateway prevents the phone from using
   * this method as a general-purpose laptop filesystem reader.
   */
  async issueAssistantReferencedImage(path: string): Promise<{
    readonly relativeUrl: string;
    readonly expiresAt: number;
  }> {
    const requestedPath = path.trim();
    if (!requestedPath) throw new TypeError("Image path is required");
    if (requestedPath.length > 32 * 1024) throw new RangeError("Image path is too long");
    if (!isAbsolute(requestedPath)) {
      throw new TypeError("An external assistant image must use an absolute path");
    }
    return this.issueCanonicalImage(await realpath(resolve(requestedPath)));
  }

  private async issueCanonicalImage(canonicalFile: string): Promise<{
    readonly relativeUrl: string;
    readonly expiresAt: number;
  }> {
    const file = await stat(canonicalFile);
    if (!file.isFile()) throw new TypeError("Image path must point to a regular file");
    if (file.size <= 0 || file.size > ANDROID_ASSET_MAX_BYTES) {
      throw new RangeError("Image exceeds the 40 MB preview limit");
    }
    const mimeType = await imageMimeType(canonicalFile);
    if (!mimeType) throw new TypeError("Image must be a PNG, JPEG, GIF, WebP, or BMP file");

    this.prune();
    while (this.tickets.size >= ANDROID_ASSET_MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (typeof oldest !== "string") break;
      this.tickets.delete(oldest);
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + ANDROID_ASSET_TTL_MS;
    this.tickets.set(token, {
      path: canonicalFile,
      mimeType,
      size: file.size,
      expiresAt,
    });
    return {
      relativeUrl: `${ANDROID_ASSET_ROUTE_PREFIX}${token}/${encodeURIComponent(basename(canonicalFile))}`,
      expiresAt,
    };
  }

  response(pathname: string, method: string): Response | null {
    if (!pathname.startsWith(ANDROID_ASSET_ROUTE_PREFIX)) return null;
    const token = assetTokenFromPathname(pathname);
    if (!token) {
      return new Response(null, {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }
    const asset = this.tickets.get(token);
    if (!asset || asset.expiresAt <= this.now()) {
      if (asset) this.tickets.delete(token);
      return new Response(null, {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }
    return new Response(method === "HEAD" ? null : Bun.file(asset.path), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(asset.size),
        "Cache-Control": "private, max-age=3600, immutable",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(asset.path))}`,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  }

  async thumbnailResponse(pathname: string, method: string): Promise<Response | null> {
    if (!pathname.startsWith(ANDROID_ASSET_ROUTE_PREFIX) || !pathname.endsWith("/thumbnail")) return null;
    const validation = this.response(pathname, method === "GET" ? "HEAD" : method);
    if (!validation || validation.status !== 200) return validation;
    const token = assetTokenFromPathname(pathname)!;
    const asset = this.tickets.get(token)!;
    try {
      let pending = this.thumbnails.get(token);
      if (!pending) {
        pending = this.thumbnailQueue.then(async () => {
          if (!this.tickets.has(token) || asset.expiresAt <= this.now()) throw new Error("Expired image");
          return sharp(asset.path, { limitInputPixels: 40_000_000, sequentialRead: true })
            .rotate().resize(256, 256, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 55 }).toBuffer();
        });
        this.thumbnailQueue = pending.catch(() => undefined);
        this.thumbnails.set(token, pending);
        if (this.thumbnails.size > 32) this.thumbnails.delete(this.thumbnails.keys().next().value!);
      }
      const bytes = await pending;
      return new Response(method === "HEAD" ? null : new Uint8Array(bytes), { headers: {
        "Content-Type": "image/webp", "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=3600, immutable", "X-Content-Type-Options": "nosniff",
      } });
    } catch {
      this.thumbnails.delete(token);
      return new Response(null, { status: 422, headers: { "Cache-Control": "no-store" } });
    }
  }

  clear(): void {
    this.tickets.clear();
    this.thumbnails.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, asset] of this.tickets) {
      if (asset.expiresAt <= now) this.tickets.delete(token);
    }
  }
}
