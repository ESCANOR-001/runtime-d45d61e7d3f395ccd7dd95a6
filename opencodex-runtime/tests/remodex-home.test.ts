import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRemodexHomeWarningMemosForTests,
  hasLegacyRemodexServiceRoot,
  hasStrongRemodexEvidence,
  preflightLegacyRemodexServiceMigration,
  resolveDefaultRemodexHome,
} from "../src/lib/remodex-home";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  rebaseConfigOwnershipRoot,
  recordOwnedConfigPath,
} from "../src/lib/config-ownership";

const roots: string[] = [];

afterEach(() => {
  clearRemodexHomeWarningMemosForTests();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function testHome(): string {
  const root = mkdtempSync(join(tmpdir(), "remodex-home-"));
  roots.push(root);
  return root;
}

function createLegacyState(home: string, name = "config.json"): string {
  const legacy = join(home, ".opencodex");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, name), name === "config.json"
    ? JSON.stringify({ providers: {}, defaultProvider: "openai" })
    : "state\n");
  return legacy;
}

describe("default Remodex home resolution", () => {
  test("uses the canonical .remodex directory for a fresh home", () => {
    const home = testHome();
    const result = resolveDefaultRemodexHome({ home });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("new");
    expect(existsSync(join(home, ".opencodex"))).toBe(false);
  });

  test("atomically migrates a strongly identified legacy home", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    const warnings: string[] = [];

    const result = resolveDefaultRemodexHome({ home, warn: message => warnings.push(message) });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("migrated");
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(home, ".remodex", "config.json"), "utf8")).toContain("defaultProvider");
    expect(warnings).toHaveLength(0);
  });

  test("does not move an ambiguous legacy directory", () => {
    const home = testHome();
    const legacy = join(home, ".opencodex");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "notes.txt"), "not Remodex state\n");

    const result = resolveDefaultRemodexHome({ home });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("new");
    expect(existsSync(legacy)).toBe(true);
  });

  test("prefers canonical state and leaves both populated roots untouched", () => {
    const home = testHome();
    mkdirSync(join(home, ".remodex"), { recursive: true });
    const legacy = createLegacyState(home);
    const warnings: string[] = [];

    const result = resolveDefaultRemodexHome({ home, warn: message => warnings.push(message) });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("collision");
    expect(existsSync(legacy)).toBe(true);
    expect(warnings[0]).toContain("leaving the legacy directory untouched");
  });

  test("defers migration when the canonical root is blocked by a file", () => {
    const home = testHome();
    writeFileSync(join(home, ".remodex"), "blocked\n");
    createLegacyState(home);

    const result = resolveDefaultRemodexHome({ home });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("canonical-blocked");
  });

  test("keeps a legacy service root in place until service assets are repaired", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    writeFileSync(join(legacy, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: join(home, ".codex"),
      opencodexHome: legacy,
      backend: "scheduler",
    }));

    const result = resolveDefaultRemodexHome({ home });

    expect(result.path).toBe(legacy);
    expect(result.outcome).toBe("legacy-fallback");
    expect(result.warning).toContain("rmx service repair");
    expect(existsSync(legacy)).toBe(true);
  });

  test("force-migrates a stopped legacy service root into .remodex", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    writeFileSync(join(legacy, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: join(home, ".codex"),
      opencodexHome: legacy,
      backend: "scheduler",
    }));

    const result = resolveDefaultRemodexHome({
      home,
      forceLegacyServiceMigration: true,
    });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("migrated");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(home, ".remodex", "service-state.json"))).toBe(true);
  });

  test("identifies a legacy service root without treating ordinary legacy state as a service", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    expect(hasLegacyRemodexServiceRoot({ home })).toBe(false);
    writeFileSync(join(legacy, "opencodex-service.cmd"), "service\n");
    expect(hasLegacyRemodexServiceRoot({ home })).toBe(true);
  });

  test("force migration refuses to merge a populated canonical root", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    mkdirSync(join(home, ".remodex"), { recursive: true });
    writeFileSync(join(home, ".remodex", "config.json"), "{}\n");
    writeFileSync(join(legacy, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: join(home, ".codex"),
      opencodexHome: legacy,
      backend: "scheduler",
    }));

    const result = resolveDefaultRemodexHome({
      home,
      forceLegacyServiceMigration: true,
    });

    expect(result.outcome).toBe("collision");
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(home, ".remodex", "config.json"))).toBe(true);
  });

  test("preflight reports a populated canonical collision without changing either root", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    writeFileSync(join(legacy, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: join(home, ".codex"),
      opencodexHome: legacy,
      backend: "scheduler",
    }));
    mkdirSync(join(home, ".remodex"), { recursive: true });
    writeFileSync(join(home, ".remodex", "keep.txt"), "canonical state\n");
    const warnings: string[] = [];

    const result = preflightLegacyRemodexServiceMigration({
      home,
      warn: message => warnings.push(message),
    });

    expect(result.outcome).toBe("collision");
    expect(result.path).toBe(legacy);
    expect(existsSync(join(legacy, "service-state.json"))).toBe(true);
    expect(readFileSync(join(home, ".remodex", "keep.txt"), "utf8")).toBe("canonical state\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("No files were changed");
  });

  test("falls back without moving when the rename is locked", () => {
    const home = testHome();
    const legacy = createLegacyState(home);
    const canonical = join(home, ".remodex");
    const warnings: string[] = [];
    const io = {
      lstat: (path: string) => lstatSync(path),
      readdir: (path: string) => readdirSync(path),
      readFile: (path: string) => readFileSync(path, "utf8"),
      rename: () => {
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      },
    };

    const result = resolveDefaultRemodexHome({
      home,
      io,
      warn: message => warnings.push(message),
    });

    expect(result.path).toBe(legacy);
    expect(result.outcome).toBe("legacy-fallback");
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(canonical)).toBe(false);
    expect(warnings[0]).toContain("EBUSY");
  });

  test("a read-only probe can disable migration explicitly", () => {
    const home = testHome();
    const legacy = createLegacyState(home);

    const result = resolveDefaultRemodexHome({ home, migrate: false });

    expect(result.path).toBe(join(home, ".remodex"));
    expect(result.outcome).toBe("migration-deferred");
    expect(existsSync(legacy)).toBe(true);
  });

  test("detects only strong Remodex evidence", () => {
    const home = testHome();
    const legacy = join(home, ".opencodex");
    mkdirSync(legacy, { recursive: true });
    expect(hasStrongRemodexEvidence(legacy)).toBe(false);
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ providers: {} }));
    expect(hasStrongRemodexEvidence(legacy)).toBe(true);
  });
});

describe("ownership metadata after home migration", () => {
  test("rebases both metadata roots without changing ownership identity", () => {
    const home = testHome();
    const oldRoot = join(home, ".opencodex");
    const newRoot = join(home, ".remodex");
    mkdirSync(oldRoot, { recursive: true });
    expect(recordOwnedConfigPath(oldRoot, join(oldRoot, "config.json"))).toBe(true);
    writeFileSync(join(oldRoot, "config.json"), "{}\n");
    renameSync(oldRoot, newRoot);

    expect(rebaseConfigOwnershipRoot(oldRoot, newRoot)).toBe(true);
    const owner = JSON.parse(readFileSync(join(newRoot, CONFIG_OWNER_FILE), "utf8")) as { root: string; ownerId: string };
    const manifest = JSON.parse(readFileSync(join(newRoot, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { root: string; ownerId: string };
    expect(owner.root).toBe(realpathSync.native(newRoot));
    expect(manifest.root).toBe(realpathSync.native(newRoot));
    expect(manifest.ownerId).toBe(owner.ownerId);
  });

  test("rebases through an aliased parent after the old directory has disappeared", () => {
    const home = testHome();
    const nativeParent = join(home, "native-parent");
    const aliasParent = join(home, "alias-parent");
    mkdirSync(nativeParent);
    symlinkSync(nativeParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const oldRoot = join(aliasParent, ".opencodex");
    const newRoot = join(aliasParent, ".remodex");
    mkdirSync(oldRoot);
    expect(recordOwnedConfigPath(oldRoot, join(oldRoot, "config.json"))).toBe(true);
    const before = JSON.parse(readFileSync(join(oldRoot, CONFIG_OWNER_FILE), "utf8"));
    renameSync(oldRoot, newRoot);
    expect(existsSync(oldRoot)).toBe(false);
    expect(rebaseConfigOwnershipRoot(join(aliasParent, "unrelated"), newRoot)).toBe(false);
    expect(JSON.parse(readFileSync(join(newRoot, CONFIG_OWNER_FILE), "utf8"))).toEqual(before);
    expect(rebaseConfigOwnershipRoot(oldRoot, newRoot)).toBe(true);
    const owner = JSON.parse(readFileSync(join(newRoot, CONFIG_OWNER_FILE), "utf8"));
    const manifest = JSON.parse(readFileSync(join(newRoot, CONFIG_UNINSTALL_MANIFEST), "utf8"));
    expect(owner).toEqual({ ...before, root: realpathSync.native(newRoot) });
    expect(manifest.root).toBe(owner.root);
    expect(manifest.ownerId).toBe(before.ownerId);
    expect(rebaseConfigOwnershipRoot(oldRoot, newRoot)).toBe(true);
    manifest.ownerId = "00000000-0000-4000-8000-000000000000";
    writeFileSync(join(newRoot, CONFIG_UNINSTALL_MANIFEST), JSON.stringify(manifest));
    const bytes = readFileSync(join(newRoot, CONFIG_UNINSTALL_MANIFEST));
    expect(rebaseConfigOwnershipRoot(oldRoot, newRoot)).toBe(false);
    expect(readFileSync(join(newRoot, CONFIG_UNINSTALL_MANIFEST))).toEqual(bytes);
  });
});
