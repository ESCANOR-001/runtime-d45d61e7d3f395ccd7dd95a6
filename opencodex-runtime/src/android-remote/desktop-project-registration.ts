import { posix, win32 } from "node:path";

import { openCodexDesktopUrl } from "./desktop-ipc";
import {
  readDesktopWorkspaceSnapshot,
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
 * Registers an Android-selected folder through Codex Desktop's public deep
 * link and confirms the write in Desktop's own global project registry.
 *
 * The confirmation is intentional: adding the row to the Android gateway
 * before Desktop accepts the route would create a phone-only project that
 * disappears on the next Desktop refresh or runtime restart.
 */
export class CodexDesktopProjectRegistrar implements AndroidDesktopProjectRegistrar {
  private readonly platform: NodeJS.Platform;
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly readProjects: () => Promise<readonly DesktopWorkspaceProject[]>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(options: DesktopProjectRegistrarOptions = {}) {
    this.platform = options.platform ?? process.platform;
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
