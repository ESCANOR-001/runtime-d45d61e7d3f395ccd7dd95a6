import { posix, win32 } from "node:path";
import { createHash } from "node:crypto";

import { openCodexDesktopUrl } from "./desktop-ipc";
import {
  readDesktopWorkspaceSnapshot,
  DESKTOP_CODEX_PROJECT_ID_PREFIX,
  type DesktopWorkspaceProject,
} from "./desktop-workspace-state";

export type DesktopProjectRegistration = {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
};

export type AndroidDesktopProjectRegistrar = {
  registerProject(input: {
    readonly workspaceRoot: string;
    readonly requestedProjectId?: string | undefined;
    readonly requestedTitle?: string | undefined;
  }): Promise<DesktopProjectRegistration>;
};

export type DesktopProjectRegistrarOptions = {
  platform?: NodeJS.Platform;
  codexHome?: string;
  openUrl?: (url: string) => Promise<void>;
  readProjects?: () => Promise<readonly DesktopWorkspaceProject[]>;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_MS = 100;

function pathKey(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
  }
  return posix.normalize(value).replace(/\/+$/u, "") || "/";
}

function projectMatchesRoot(
  project: DesktopWorkspaceProject,
  workspaceRoot: string,
  platform: NodeJS.Platform,
): boolean {
  return pathKey(project.workspaceRoot, platform) === pathKey(workspaceRoot, platform);
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
}

function registrationFromProject(project: DesktopWorkspaceProject): DesktopProjectRegistration {
  return {
    projectId: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  };
}

/**
 * Registers an Android-selected folder through Codex's native project API.
 * Older versions fall back to a deep link confirmed in Desktop's registry.
 *
 * The confirmation is intentional: adding the row to the Android gateway
 * before Desktop confirms the project would create a phone-only project that
 * disappears on the next Desktop refresh or runtime restart.
 */
export class CodexDesktopProjectRegistrar implements AndroidDesktopProjectRegistrar {
  private readonly platform: NodeJS.Platform;
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly readProjects: () => Promise<readonly DesktopWorkspaceProject[]>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly request: DesktopProjectRegistrarOptions["request"];

  constructor(options: DesktopProjectRegistrarOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.request = options.request;
    this.openUrl = options.openUrl ?? (url => openCodexDesktopUrl({
      url,
      platform: this.platform,
    }));
    this.readProjects = options.readProjects ?? (async () => (
      await readDesktopWorkspaceSnapshot([], options.codexHome)
    ).projects);
    this.timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.pollMs = Math.max(20, Math.floor(options.pollMs ?? DEFAULT_POLL_MS));
  }

  async registerProject(input: {
    readonly workspaceRoot: string;
    readonly requestedProjectId?: string | undefined;
    readonly requestedTitle?: string | undefined;
  }): Promise<DesktopProjectRegistration> {
    const workspaceRoot = input.workspaceRoot.trim();
    const existing = await this.findProject(workspaceRoot);
    if (existing) return registrationFromProject(existing);

    if (this.request) {
      try {
        // Current Desktop stores projects through the native app-server API.
        // Opening a draft with codex://new no longer registers a project.
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const result = await this.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
          if (!result || typeof result !== "object") throw new Error("Codex returned an invalid project list.");
          const list = result as { data?: unknown; nextCursor?: unknown };
          if (!Array.isArray(list.data)) throw new Error("Codex returned an invalid project list.");
          for (const value of list.data) {
            const project = this.nativeRegistration(value, workspaceRoot);
            if (project) return project;
          }
          cursor = typeof list.nextCursor === "string" && list.nextCursor ? list.nextCursor : null;
          if (!cursor) break;
          if (page === 9) throw new Error("Too many projects to check safely. Choose an existing project or retry.");
        }
        const digest = createHash("sha256").update(`remodex-project:${pathKey(workspaceRoot, this.platform)}`).digest("hex");
        const idempotencyKey = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const result = await this.request("project/create", {
          name: input.requestedTitle?.trim() || (this.platform === "win32" ? win32 : posix).basename(workspaceRoot),
          roots: [{ path: workspaceRoot }], idempotencyKey,
        });
        const project = result && typeof result === "object" ? this.nativeRegistration((result as { project?: unknown }).project, workspaceRoot) : null;
        if (!project) throw new Error("Codex did not confirm the selected project folder.");
        return project;
      } catch (error) {
        // Unknown-method is a definitive pre-delivery rejection. Other errors,
        // including timeouts, must not create another project through a fallback.
        const message = error instanceof Error ? error.message : String(error);
        if (!/method (?:not found|not supported)|unknown method|-32601|unrecognized (?:method|request)/iu.test(message)) throw error;
      }
    }

    const url = `codex://new?path=${encodeURIComponent(workspaceRoot)}`;
    try {
      await this.openUrl(url);
    } catch (error) {
      throw new Error(
        `Codex Desktop could not open the project route: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const project = await this.findProject(workspaceRoot);
      if (project) return registrationFromProject(project);
      await waitMs(this.pollMs);
    }

    throw new Error(
      "Codex Desktop did not confirm this project. The folder was not added on Android.",
    );
  }

  private nativeRegistration(value: unknown, workspaceRoot: string): DesktopProjectRegistration | null {
    if (!value || typeof value !== "object") return null;
    const project = value as { id?: unknown; name?: unknown; roots?: unknown };
    if (typeof project.id !== "string" || !project.id || !Array.isArray(project.roots)) return null;
    const matches = project.roots.some(value => value && typeof value === "object" &&
      typeof value.path === "string" && pathKey(value.path, this.platform) === pathKey(workspaceRoot, this.platform));
    if (!matches) return null;
    return { projectId: `${DESKTOP_CODEX_PROJECT_ID_PREFIX}${project.id}`, workspaceRoot,
      title: typeof project.name === "string" && project.name ? project.name : (this.platform === "win32" ? win32 : posix).basename(workspaceRoot) };
  }

  private async findProject(workspaceRoot: string): Promise<DesktopWorkspaceProject | null> {
    let projects: readonly DesktopWorkspaceProject[];
    try {
      projects = await this.readProjects();
    } catch {
      return null;
    }
    return projects.find(project => projectMatchesRoot(project, workspaceRoot, this.platform)) ?? null;
  }
}
