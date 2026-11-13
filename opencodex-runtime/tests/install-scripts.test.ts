import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("install scripts", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      name?: string;
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
      repository?: { type?: string; url?: string; directory?: string };
      homepage?: string;
      bugs?: { url?: string };
      publishConfig?: { access?: string };
    };

    expect(pkg.name).toBe("@remodex/rmx");
    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.bin).toEqual({
      // npm 11 normalizes bin targets to package-relative paths. Keeping the
      // normalized form in source prevents npm publish from dropping all bins.
      rmx: "bin/ocx.mjs",
      remodex: "bin/ocx.mjs",
      opencodex: "bin/ocx.mjs",
      ocx: "bin/ocx.mjs",
    });
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ESCANOR-001/remodex-android.git",
      directory: "opencodex-runtime",
    });
    expect(pkg.homepage).toBe("https://remodex.net/");
    expect(pkg.bugs?.url).toBe("https://github.com/ESCANOR-001/remodex-android/issues");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/connect.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/connect.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
    expect(pkg.files?.some(path => path === "desktop" || path.startsWith("desktop/"))).toBe(false);
    expect(pkg.files).toContain("gui/dist");
    for (const script of ["prepack", "prepublishOnly", "build:gui", "prepare:package"]) {
      expect(pkg.scripts?.[script]).not.toMatch(/desktop|tauri|cargo/);
    }
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.packageName !== '@remodex/rmx' || m.cliCommand !== 'rmx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("Remodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("npm install -g @remodex/rmx");
    expect(script).toContain("command -v \"$candidate\"");
    expect(script).toContain("rmx remodex opencodex ocx");
    expect(script).toContain("\"$CLI_COMMAND\" help");
    expect(script).not.toContain("bun install -g @remodex/rmx");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("& $npm.Source install -g @remodex/rmx");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command rmx.cmd");
    expect(script).toContain("Get-Command rmx");
    expect(script).toContain("& $cli.Source help");
    expect(script).not.toContain("bun install -g @remodex/rmx");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test("private Node launcher blocks npm self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('const forwardedCliArgs = userCliArgs.length === 0 ? ["help"] : userCliArgs');
    expect(launcher).toContain('if (["update", "__exact-update"].includes(process.argv[2]))');
    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded()");
    expect(launcher).toContain("runNpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    // The invariant is that the dispatched run is located by workflow, branch
    // and commit — not that the call is a shell string. Every external command
    // now goes through the shared launcher as an argv array, because Bun.$
    // resolved PATH itself and walked past the Windows `.cmd` test shims.
    expect(script).toContain('"gh", "run", "list", "--workflow", "release.yml", "--branch"');
    expect(script).toContain('"--commit"');
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });
});
