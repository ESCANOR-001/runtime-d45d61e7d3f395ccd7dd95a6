import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { getConfigDir } from "../config";

export const CLOUDFLARED_VERSION = "2026.8.3";
export const OPENCODEX_CLOUDFLARED_PATH = "OPENCODEX_CLOUDFLARED_PATH";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const STALE_INSTALL_LOCK_MS = 10 * 60 * 1_000;

export type CloudflaredReleaseAsset = {
  url: string;
  sha256: string;
  archive: "binary" | "tgz";
};

const RELEASES: Readonly<Partial<Record<string, CloudflaredReleaseAsset>>> = {
  "darwin-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-arm64.tgz",
    sha256: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
    archive: "tgz",
  },
  "darwin-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-amd64.tgz",
    sha256: "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
    archive: "tgz",
  },
  "linux-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-arm64",
    sha256: "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391",
    archive: "binary",
  },
  "linux-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64",
    sha256: "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
    archive: "binary",
  },
  "win32-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-windows-amd64.exe",
    sha256: "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae",
    archive: "binary",
  },
};

export type CloudflaredExecutable = {
  path: string;
  source: "override" | "managed" | "path";
  version: string;
};

export class CloudflaredInstallError extends Error {
  constructor(
    readonly code:
      | "unsupported_platform"
      | "override_missing"
      | "download_failed"
      | "invalid_checksum"
      | "write_failed"
      | "validation_failed",
    message: string,
  ) {
    super(message);
    this.name = "CloudflaredInstallError";
  }
}

export function cloudflaredReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CloudflaredReleaseAsset | null {
  const executableArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  return RELEASES[`${platform}-${executableArch}`] ?? null;
}

function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function executableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function pathCloudflared(platform: NodeJS.Platform = process.platform): string | null {
  const path = process.env.PATH ?? process.env.Path ?? "";
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory.trim().replace(/^"|"$/gu, ""), executableName(platform));
    if (directory.trim() && executableFile(candidate, platform)) return candidate;
  }
  return null;
}

async function download(asset: CloudflaredReleaseAsset): Promise<Uint8Array> {
  let url = new URL(asset.url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (url.protocol !== "https:") {
      throw new CloudflaredInstallError("download_failed", "Cloudflared download redirected to an insecure URL.");
    }
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new CloudflaredInstallError("download_failed", "Cloudflared could not be downloaded.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new CloudflaredInstallError("download_failed", "Cloudflared download redirected too many times.");
      }
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      throw new CloudflaredInstallError("download_failed", `Cloudflared download failed with HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new CloudflaredInstallError("download_failed", "Cloudflared download was unexpectedly large.");
    }
    if (!response.body) {
      throw new CloudflaredInstallError("download_failed", "Cloudflared download had no response body.");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          throw new CloudflaredInstallError("download_failed", "Cloudflared download was unexpectedly large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) {
      throw new CloudflaredInstallError("download_failed", "Cloudflared download had an invalid size.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new CloudflaredInstallError("invalid_checksum", "Cloudflared download did not match its pinned checksum.");
    }
    return bytes;
  }
  throw new CloudflaredInstallError("download_failed", "Cloudflared could not be downloaded.");
}

async function run(command: string, args: readonly string[]): Promise<void> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args], {
      windowsHide: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    throw new CloudflaredInstallError("validation_failed", "Cloudflared could not be started.");
  }
  if ((await child.exited) !== 0) {
    throw new CloudflaredInstallError("validation_failed", "Cloudflared did not pass its executable check.");
  }
}

let installPromise: Promise<CloudflaredExecutable> | null = null;

export async function resolveCloudflared(configDir = getConfigDir()): Promise<CloudflaredExecutable> {
  const override = process.env[OPENCODEX_CLOUDFLARED_PATH]?.trim();
  if (override) {
    if (!executableFile(override)) {
      throw new CloudflaredInstallError(
        "override_missing",
        `${OPENCODEX_CLOUDFLARED_PATH} does not point to an executable file.`,
      );
    }
    return { path: override, source: "override", version: CLOUDFLARED_VERSION };
  }

  const managedPath = join(
    configDir,
    "tools",
    "cloudflared",
    CLOUDFLARED_VERSION,
    `${process.platform}-${process.arch}`,
    executableName(),
  );
  if (executableFile(managedPath)) {
    return { path: managedPath, source: "managed", version: CLOUDFLARED_VERSION };
  }
  const fromPath = pathCloudflared();
  if (fromPath) return { path: fromPath, source: "path", version: CLOUDFLARED_VERSION };

  if (installPromise) return installPromise;
  installPromise = (async (): Promise<CloudflaredExecutable> => {
    const asset = cloudflaredReleaseAsset();
    if (!asset) {
      throw new CloudflaredInstallError(
        "unsupported_platform",
        `Remodex does not provide managed cloudflared for ${process.platform}-${process.arch}.`,
      );
    }

    const directory = dirname(managedPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = `${managedPath}.lock`;
    let lock: number | null = null;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          lock = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (executableFile(managedPath)) {
            return { path: managedPath, source: "managed", version: CLOUDFLARED_VERSION };
          }
          try {
            if (statSync(lockPath).mtimeMs < Date.now() - STALE_INSTALL_LOCK_MS) {
              rmSync(lockPath, { force: true });
              continue;
            }
          } catch {
            continue;
          }
          await Bun.sleep(100);
        }
      }
      if (lock === null) {
        throw new CloudflaredInstallError("write_failed", "Another cloudflared installation is still running.");
      }
      if (executableFile(managedPath)) {
        return { path: managedPath, source: "managed", version: CLOUDFLARED_VERSION };
      }

      const temporaryDirectory = join(directory, `.install-${randomUUID()}`);
      mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 });
      try {
        const bytes = await download(asset);
        const downloadedPath = join(
          temporaryDirectory,
          asset.archive === "tgz" ? "cloudflared.tgz" : executableName(),
        );
        writeFileSync(downloadedPath, bytes, { mode: 0o600 });
        const executablePath = join(temporaryDirectory, executableName());
        if (asset.archive === "tgz") {
          await run("tar", ["-xzf", downloadedPath, "-C", temporaryDirectory]);
        }
        if (process.platform !== "win32") chmodSync(executablePath, 0o755);
        try {
          await run(executablePath, ["--version"]);
        } catch (error) {
          if (process.platform === "win32" && process.arch === "arm64") {
            throw new CloudflaredInstallError("validation_failed", "Cloudflared requires Windows 11 x64 emulation on ARM. Use Local Wi-Fi or provide a compatible executable through OPENCODEX_CLOUDFLARED_PATH.");
          }
          throw error;
        }
        const staged = `${managedPath}.${randomUUID()}.tmp`;
        renameSync(executablePath, staged);
        renameSync(staged, managedPath);
      } catch (error) {
        if (error instanceof CloudflaredInstallError) throw error;
        throw new CloudflaredInstallError("write_failed", "Cloudflared could not be installed.");
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      return { path: managedPath, source: "managed", version: CLOUDFLARED_VERSION };
    } finally {
      if (lock !== null) closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  })().finally(() => {
    installPromise = null;
  });
  return await installPromise;
}
