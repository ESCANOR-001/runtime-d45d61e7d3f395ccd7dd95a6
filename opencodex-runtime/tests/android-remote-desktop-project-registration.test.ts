import { describe, expect, test } from "bun:test";

import {
  CodexDesktopProjectRegistrar,
  type DesktopProjectRegistration,
} from "../src/android-remote/desktop-project-registration";
import type { DesktopWorkspaceProject } from "../src/android-remote/desktop-workspace-state";

const project = (workspaceRoot: string): DesktopWorkspaceProject => ({
  id: "codex-desktop-project-test",
  title: "Test project",
  workspaceRoot,
});

describe("Codex Desktop project registration", () => {
  test("is idempotent when Desktop already has the folder", async () => {
    const opened: string[] = [];
    const registrar = new CodexDesktopProjectRegistrar({
      platform: "linux",
      openUrl: async url => { opened.push(url); },
      readProjects: async () => [project("/work/remodex")],
      timeoutMs: 250,
    });

    const result = await registrar.registerProject({ workspaceRoot: "/work/remodex" });

    expect(result).toEqual<DesktopProjectRegistration>({
      projectId: "codex-desktop-project-test",
      title: "Test project",
      workspaceRoot: "/work/remodex",
    });
    expect(opened).toEqual([]);
  });

  test("opens Desktop's project route and waits for registry confirmation", async () => {
    const opened: string[] = [];
    let reads = 0;
    const registrar = new CodexDesktopProjectRegistrar({
      platform: "linux",
      openUrl: async url => { opened.push(url); },
      readProjects: async () => {
        reads += 1;
        return reads < 2 ? [] : [project("/work/remodex")];
      },
      timeoutMs: 500,
      pollMs: 20,
    });

    await expect(registrar.registerProject({ workspaceRoot: "/work/remodex" })).resolves.toMatchObject({
      projectId: "codex-desktop-project-test",
    });
    expect(opened).toEqual(["codex://new?path=%2Fwork%2Fremodex"]);
  });

  test("fails closed when Desktop never confirms the folder", async () => {
    const registrar = new CodexDesktopProjectRegistrar({
      platform: "linux",
      openUrl: async () => undefined,
      readProjects: async () => [],
      timeoutMs: 250,
      pollMs: 20,
    });

    await expect(
      registrar.registerProject({ workspaceRoot: "/work/missing" }),
    ).rejects.toThrow("did not confirm this project");
  });
});

