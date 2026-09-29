/**
 * Collect native Tauri installer files for one desktop target.
 *
 * The desktop staging step is deliberately target-native: the bundle contains
 * a target Bun executable and target-specific native dependencies. This helper
 * only copies the completed installer files into a stable, target-prefixed
 * directory and writes metadata consumed by the release-publishing job.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

type BundleFormat = "deb" | "rpm" | "appimage" | "exe" | "msi" | "dmg" | "pkg";

interface ArtifactRecord {
  name: string;
  sourceName: string;
  format: BundleFormat;
  size: number;
  sha256: string;
  primary: boolean;
}

interface ArtifactMetadata {
  schemaVersion: 1;
  targetKey: string;
  version: string;
  files: ArtifactRecord[];
}

const FORMAT_BY_EXTENSION: Record<string, BundleFormat> = {
  ".deb": "deb",
  ".rpm": "rpm",
  ".appimage": "appimage",
  ".exe": "exe",
  ".msi": "msi",
  ".dmg": "dmg",
  ".pkg": "pkg",
};

const PRIMARY_FORMATS: Record<string, readonly BundleFormat[]> = {
  linux: ["deb", "rpm"],
  windows: ["exe", "msi"],
  darwin: ["dmg", "pkg"],
};

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function safeFileName(targetKey: string, sourceName: string): string {
  const cleaned = sourceName.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${targetKey}-${cleaned}`;
}

async function main(): Promise<void> {
  const targetKey = option("--target-key");
  const version = option("--version");
  const bundleDirectory = resolve(option("--bundle-dir"));
  const outputDirectory = resolve(option("--out-dir"));

  if (!/^(?:linux|windows|darwin)-(?:x64|arm64|ia32)$/.test(targetKey)) {
    throw new Error(`Unsupported desktop target key: ${targetKey}`);
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }

  const allCandidates = walkFiles(bundleDirectory)
    .map(path => {
      const extension = extname(path).toLowerCase();
      const format = FORMAT_BY_EXTENSION[extension];
      return format ? { path, format } : null;
    })
    .filter((value): value is { path: string; format: BundleFormat } => value !== null)
    .sort((left, right) => left.path.localeCompare(right.path));

  // A clean GitHub runner normally has no older bundles, but local rebuilds
  // can leave a previous version beside the new one. Never publish a stale
  // installer just because it has a supported extension.
  const candidates = allCandidates.filter(candidate => basename(candidate.path).includes(version));
  if (candidates.length === 0) {
    throw new Error(`No native installer files for ${version} were found under ${bundleDirectory}`);
  }

  const targetDirectory = join(outputDirectory, targetKey);
  mkdirSync(targetDirectory, { recursive: true });
  const primaryFormats = PRIMARY_FORMATS[targetKey.split("-", 1)[0] ?? ""] ?? [];
  const preferred = primaryFormats.find(format => candidates.some(candidate => candidate.format === format));
  if (!preferred) {
    throw new Error(`No supported primary installer was produced for ${targetKey}`);
  }

  const files: ArtifactRecord[] = [];
  let primaryAssigned = false;
  for (const candidate of candidates) {
    const sourceName = basename(candidate.path);
    const name = safeFileName(targetKey, sourceName);
    const destination = join(targetDirectory, name);
    if (existsSync(destination)) {
      throw new Error(`Duplicate installer filename after normalization: ${name}`);
    }
    copyFileSync(candidate.path, destination);
    const size = statSync(destination).size;
    const primary = candidate.format === preferred && !primaryAssigned;
    if (primary) primaryAssigned = true;
    files.push({
      name,
      sourceName,
      format: candidate.format,
      size,
      sha256: await sha256File(destination),
      primary,
    });
  }

  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    targetKey,
    version,
    files,
  };
  writeFileSync(
    join(targetDirectory, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Collected ${files.length} installer file(s) for ${targetKey}; `
      + `primary=${files.find(file => file.primary)?.name ?? "none"}`,
  );
}

await main();
