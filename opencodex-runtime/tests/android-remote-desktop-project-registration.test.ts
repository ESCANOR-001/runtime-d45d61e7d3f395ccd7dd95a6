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
  test("uses native project creation and a stable retry key instead of opening a draft", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let opened = false;
    const registrar = new CodexDesktopProjectRegistrar({ platform: "linux", readProjects: async () => [],
      openUrl: async () => { opened = true; },
      request: async (method, params) => {
        calls.push({ method, params });
        return method === "project/list" ? { data: [], nextCursor: null }
          : { project: { id: "native-project", name: "My folder", roots: [{ path: "/work/new-folder" }] } };
      } });
    const first = await registrar.registerProject({ workspaceRoot: "/work/new-folder", requestedProjectId: "phone-one" });
    await registrar.registerProject({ workspaceRoot: "/work/new-folder", requestedProjectId: "phone-retry" });
    expect(first).toEqual({ projectId: "codex-desktop-project-native-project", title: "My folder", workspaceRoot: "/work/new-folder" });
    expect(calls[1]!.params.idempotencyKey).toBe(calls[3]!.params.idempotencyKey);
    expect(calls[1]!.params.roots).toEqual([{ path: "/work/new-folder" }]);
    expect(opened).toBe(false);
  });

  test("finds an existing native project across pages and Windows path spelling", async () => {
    const calls: string[] = [];
    const registrar = new CodexDesktopProjectRegistrar({ platform: "win32", readProjects: async () => [],
      request: async (method, params) => {
        calls.push(method);
        return params.cursor ? { data: [{ id: "windows-project", name: "Windows folder", roots: [{ path: "C:\\Work\\Project" }] }], nextCursor: null }
          : { data: [], nextCursor: "next" };
      } });
    expect((await registrar.registerProject({ workspaceRoot: "c:/work/project/" })).projectId).toBe("codex-desktop-project-windows-project");
    expect(calls).toEqual(["project/list", "project/list"]);
  });

  test("only unsupported native methods use the older Desktop route", async () => {
    let opened = false;
    const registrar = new CodexDesktopProjectRegistrar({ readProjects: async () => opened ? [project("/work/older")] : [],
      openUrl: async () => { opened = true; }, request: async () => { throw new Error("Method not found (-32601)"); } });
    expect((await registrar.registerProject({ workspaceRoot: "/work/older" })).workspaceRoot).toBe("/work/older");
    expect(opened).toBe(true);
  });

  test.each(["Request timed out", "Permission denied"])("does not replay a native failure through Desktop: %s", async message => {
    let opened = false;
    const registrar = new CodexDesktopProjectRegistrar({ readProjects: async () => [], openUrl: async () => { opened = true; },
      request: async method => { if (method === "project/list") return { data: [], nextCursor: null }; throw new Error(message); } });
    await expect(registrar.registerProject({ workspaceRoot: "/work/failure" })).rejects.toThrow(message);
    expect(opened).toBe(false);
  });

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

