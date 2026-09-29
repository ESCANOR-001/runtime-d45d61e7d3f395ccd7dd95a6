import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  test("CLI exposes a one-shot local state cleanup command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain('case "uninstall"');
    expect(cli).toContain("async function handleUninstall()");
    expect(cli).toContain("uninstallServiceIfInstalled");
    expect(cli).toContain("uninstallCodexShim");
    expect(cli).toContain("restoreNativeCodex");
    expect(cli).toContain("OsAndroidRemoteCloudflareSecretStore");
    expect(cli).toContain("Cloudflare tunnel credential removed");
    expect(cli).toContain(".removeToken()");
    expect(cli).toContain("removeOwnedConfigState(getConfigDir())");
    expect(cli).not.toContain("rmSync(getConfigDir()");
  });

  test("CLI exposes explicit legacy history recovery command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain("rmx recover-history --legacy-openai");
    expect(cli).toContain("async function handleRecoverHistory()");
    // The command still performs legacy recovery, but through the serialized
    // history job rather than by calling the writer inline — the operation name
    // is what keeps it distinct from a generic restore, which must not touch the
    // backup manifest this one deliberately leaves alone.
    expect(cli).toContain("recover-legacy-openai");
    expect(cli).toContain("runCodexHistoryJob");
  });

  test("service cleanup has a quiet best-effort helper", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("export async function uninstallServiceIfInstalled()");
    expect(service).toContain("uninstallLaunchd");
    expect(service).toContain("uninstallWindows");
    expect(service).toContain("uninstallSystemd");
    const helper = service.slice(
      service.indexOf("export async function uninstallServiceIfInstalled()"),
      service.indexOf("export function isServiceInstalled()"),
    );
    expect(helper).toContain("probeWindowsSchedulerTask(TASK)");
    expect(helper).toContain("Task Scheduler status could not be verified before uninstall");
    expect(helper).not.toContain("const q = schtasks");
    expect(helper).not.toContain("catch { /* task not found */ }");
  });

  test("full uninstall kills the tracked proxy before deleting service assets", async () => {
    const cli = await readText("src/cli/index.ts");
    const uninstallBody = cli.slice(cli.indexOf("async function handleUninstall()"), cli.indexOf("type HealthCheck"));

    expect(uninstallBody).toContain('runLifecycleStep("service stopped"');
    expect(uninstallBody).toContain('runLifecycleStep("proxy stopped"');
    expect(uninstallBody).toContain('runLifecycleStep("service removed"');
    expect(uninstallBody).toContain("await stopProxy(pid);");
    expect(uninstallBody).toContain("uninstallServiceIfInstalled()");
    expect(uninstallBody.indexOf('runLifecycleStep("proxy stopped"')).toBeLessThan(uninstallBody.indexOf('runLifecycleStep("service stopped"'));
    expect(uninstallBody.indexOf('runLifecycleStep("service stopped"')).toBeLessThan(uninstallBody.indexOf('runLifecycleStep("service removed"'));
    expect(uninstallBody.indexOf("await stopProxy(pid);")).toBeLessThan(uninstallBody.indexOf("uninstallServiceIfInstalled()"));
  });
});
