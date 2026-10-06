import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  annotateDesktopTaskActivity,
  annotateDesktopWorkspaceMembership,
  DESKTOP_CODEX_PROJECT_ID_PREFIX,
} from "../src/android-remote/desktop-workspace-state";
import { projectCodexShellSnapshot, projectCodexThreadDetail } from "../src/android-remote/projection";
import { clearThreadSourcePathDiscoveryCache } from "../src/android-remote/thread-source-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearThreadSourcePathDiscoveryCache();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Android Remote Codex Desktop workspace membership", () => {
  test.each(["linux", "darwin", "win32"] as const)("%s follows newer rollout files instead of keeping an old Paused state", async platform => {
    const directory = await mkdtemp(join(tmpdir(), "opencodex-windows-continued-activity-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = join(directory, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const id = "continued-task";
    const original = join(sessionsRoot, `rollout-${id}.jsonl`);
    const continuation = join(sessionsRoot, `rollout-${id}_continuation.jsonl`);
    const row = (timestamp: string, type: string, turnId: string) => JSON.stringify({
      timestamp, type: "event_msg", payload: { type, turn_id: turnId },
    });
    const meta = (timestamp: string) => JSON.stringify({
      timestamp, type: "session_meta", payload: { id },
    });
    await writeFile(original, [
      meta("2026-09-06T08:00:00.000Z"),
      row("2026-09-06T08:01:00.000Z", "task_started", "old-turn"),
      row("2026-09-06T08:02:00.000Z", "turn_aborted", "old-turn"),
    ].join("\n") + "\n");
    const thread = { id, path: original, status: { type: "notLoaded" } };
    let now = Date.parse("2026-09-06T08:03:00.000Z");
    const options = { codexHome: directory, platform, now: () => now, isThreadActive: async () => true };
    expect((await annotateDesktopTaskActivity([thread], 50, options))[0]).toMatchObject({
      androidRemoteLatestTurnState: "interrupted",
      androidRemoteLatestTurnId: "old-turn",
    });

    // Desktop continues the same logical task, but thread/list still returns
    // the original file. A cold sidebar must discover the newer source too.
    await writeFile(continuation, [
      meta("2026-09-06T08:03:00.000Z"),
      row("2026-09-06T08:03:00.000Z", "task_started", "new-turn"),
    ].join("\n") + "\n");
    now += 31_000; // Expire the bounded source-discovery cache.
    const running = await annotateDesktopTaskActivity([thread], 50, options);
    expect(running[0]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteLatestTurnId: "new-turn",
    });
    expect((projectCodexShellSnapshot(running, 1).threads as unknown[])[0]).toMatchObject({
      latestTurn: { state: "running", turnId: "new-turn" },
      session: { status: "running", activeTurnId: "new-turn" },
    });
    expect(projectCodexThreadDetail(running[0]!, 1).thread).toMatchObject({
      latestTurn: { state: "running", turnId: "new-turn" },
      session: { status: "running", activeTurnId: "new-turn" },
    });

    await appendFile(continuation, row("2026-09-06T08:04:00.000Z", "task_complete", "new-turn") + "\n");
    expect((await annotateDesktopTaskActivity([thread], 50, options))[0]).toMatchObject({
      androidRemoteLatestTurnState: "completed",
      androidRemoteLatestTurnId: "new-turn",
    });

    await appendFile(continuation, JSON.stringify({
      timestamp: "2026-09-06T08:05:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "failed-turn", error: { message: "Request timed out" } },
    }) + "\n");
    expect((await annotateDesktopTaskActivity([thread], 50, options))[0]).toMatchObject({
      androidRemoteLatestTurnState: "error",
      androidRemoteLatestTurnId: "failed-turn",
      androidRemoteLatestTurnError: "Request timed out",
    });
    await appendFile(continuation, row("2026-09-06T08:06:00.000Z", "turn_aborted", "stopped-turn") + "\n");
    expect((await annotateDesktopTaskActivity([thread], 50, options))[0]).toMatchObject({
      androidRemoteLatestTurnState: "interrupted",
      androidRemoteLatestTurnId: "stopped-turn",
    });

  });

  test("uses explicit project assignments and leaves projectless chats ungrouped", () => {
    const rows = annotateDesktopWorkspaceMembership([
      { id: "project-thread", cwd: "/work/remodex" },
      { id: "ordinary-chat", cwd: "/work/remodex" },
    ], {
      "local-projects": {
        "project-1": { id: "project-1", name: "Remodex", rootPaths: ["/work/remodex"] },
      },
      "projectless-thread-ids": ["ordinary-chat"],
      "thread-project-assignments": {
        "project-thread": {
          projectKind: "local",
          projectId: "project-1",
          cwd: "/work/remodex",
          pendingCoreUpdate: false,
        },
      },
    });

    expect(rows[0]).toMatchObject({
      androidRemoteProjectId: `${DESKTOP_CODEX_PROJECT_ID_PREFIX}project-1`,
      androidRemoteProjectTitle: "Remodex",
      androidRemoteProjectWorkspaceRoot: "/work/remodex",
    });
    expect(rows[1]).toMatchObject({
      id: "ordinary-chat",
      cwd: "/work/remodex",
      androidRemoteWorkspaceKind: "projectless",
      androidRemoteProjectId: "codex-project-chats",
      androidRemoteProjectTitle: "Chats",
    });
  });

  test("degrades to cwd projection when Desktop state is unavailable", () => {
    const thread = { id: "thread-1", cwd: "/work/project" };
    expect(annotateDesktopWorkspaceMembership([thread], null)).toEqual([thread]);
  });

  test("groups new Windows tasks with their saved project before per-task assignments exist", () => {
    const state = {
      "local-projects": {
        saved: { name: "Saved project", rootPaths: ["C:\\Work\\Project", "D:\\OtherRoot"] },
      },
      "thread-project-assignments": {
        existing: { projectKind: "local", projectId: "saved", cwd: "C:\\Work\\Project" },
      },
    };
    const rows = annotateDesktopWorkspaceMembership([
      { id: "existing", cwd: "C:\\Work\\Project" },
      { id: "new-fork", cwd: "c:/work/project/" },
      { id: "second-root", cwd: "d:\\OTHERROOT\\" },
    ], state);
    expect(rows.map(row => row.androidRemoteProjectId)).toEqual([
      `${DESKTOP_CODEX_PROJECT_ID_PREFIX}saved`,
      `${DESKTOP_CODEX_PROJECT_ID_PREFIX}saved`,
      `${DESKTOP_CODEX_PROJECT_ID_PREFIX}saved`,
    ]);
    const snapshot = projectCodexShellSnapshot(rows, 1);
    expect(snapshot.projects).toHaveLength(1);
    expect((snapshot.threads as Array<{ projectId: string }>).every(
      row => row.projectId === `${DESKTOP_CODEX_PROJECT_ID_PREFIX}saved`,
    )).toBe(true);
  });

  test("resolves an exact project root without an assignments registry", () => {
    expect(annotateDesktopWorkspaceMembership([{ id: "new", cwd: "C:/Work/Project" }], {
      "local-projects": { saved: { name: "Saved", rootPaths: ["C:/Work/Project"] } },
    })[0]?.androidRemoteProjectId).toBe(`${DESKTOP_CODEX_PROJECT_ID_PREFIX}saved`);
  });

  test("root fallback preserves explicit projectless and Android project choices", () => {
    const rows = annotateDesktopWorkspaceMembership([
      { id: "listed-chat", cwd: "C:/Work/Project" },
      { id: "output-chat", cwd: "C:/Work/Project" },
      { id: "android-chat", cwd: "C:/Work/Project", androidRemoteWorkspaceKind: "projectless" },
      { id: "android-project", cwd: "C:/Work/Project", androidRemoteProjectId: "android-explicit" },
      { id: "assigned", cwd: "C:/Work/Project" },
    ], {
      "local-projects": {
        saved: { name: "Saved", rootPaths: ["C:/Work/Project"] },
        other: { name: "Other", rootPaths: ["D:/Other"] },
      },
      "projectless-thread-ids": ["listed-chat"],
      "thread-projectless-output-directories": { "output-chat": "C:/Work/Project" },
      "thread-project-assignments": { assigned: { projectKind: "local", projectId: "other" } },
    });
    expect(rows.map(row => row.androidRemoteProjectId)).toEqual([
      "codex-project-chats", "codex-project-chats", "codex-project-chats",
      "android-explicit", `${DESKTOP_CODEX_PROJECT_ID_PREFIX}other`,
    ]);
  });

  test("does not guess ambiguous roots, nested folders, or conflicting assignments", () => {
    const threads = [
      { id: "ambiguous", cwd: "C:/Work/Shared" },
      { id: "nested", cwd: "C:/Work/Project/child" },
      { id: "prefix", cwd: "C:/Work/Project-other" },
      { id: "nonlocal", cwd: "C:/Work/Project" },
      { id: "missing-project", cwd: "C:/Work/Project" },
      { id: "posix-case", cwd: "/work/project" },
    ];
    expect(annotateDesktopWorkspaceMembership(threads, {
      "local-projects": {
        first: { rootPaths: ["C:/Work/Shared"] },
        second: { rootPaths: ["c:\\work\\shared\\"] },
        saved: { rootPaths: ["C:/Work/Project", "/work/Project"] },
      },
      "thread-project-assignments": {
        nonlocal: { projectKind: "remote", projectId: "elsewhere" },
        "missing-project": { projectKind: "local", projectId: "removed" },
      },
    })).toEqual(threads);
  });

  test("projects authoritative running and completed task markers from Desktop sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencodex-desktop-activity-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = join(directory, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const runningPath = join(sessionsRoot, "running.jsonl");
    const completedPath = join(sessionsRoot, "completed.jsonl");
    const needsInputPath = join(sessionsRoot, "needs-input.jsonl");
    const answeredInputPath = join(sessionsRoot, "answered-input.jsonl");
    const failedPath = join(sessionsRoot, "failed.jsonl");
    const sessionMeta = (id: string) => JSON.stringify({
      timestamp: "2026-08-14T06:00:00.000Z",
      type: "session_meta",
      payload: { id },
    });
    await writeFile(runningPath, [
      sessionMeta("running"),
      JSON.stringify({ timestamp: "2026-08-14T07:00:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-old" } }),
      JSON.stringify({ timestamp: "2026-08-14T08:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-running" } }),
      JSON.stringify({ timestamp: "2026-08-14T08:01:00.000Z", type: "response_item", payload: { type: "reasoning" } }),
    ].join("\n"));
    await writeFile(completedPath, [
      sessionMeta("completed"),
      JSON.stringify({ timestamp: "2026-08-14T06:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-complete" } }),
      JSON.stringify({ timestamp: "2026-08-14T06:05:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-complete" } }),
    ].join("\n"));
    const questionCall = {
      timestamp: "2026-08-14T09:01:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        id: "input-item-1",
        name: "request_user_input",
        call_id: "call-question",
        arguments: JSON.stringify({
          questions: [{
            id: "platform_scope",
            header: "Platform",
            question: "Which platform should the UI test plan cover?",
            options: [
              { label: "Android (Recommended)", description: "Focus on Android UI tests." },
              { label: "All platforms", description: "Cover every relevant platform." },
            ],
          }],
        }),
      },
    };
    await writeFile(needsInputPath, [
      sessionMeta("needs-input"),
      JSON.stringify({ timestamp: "2026-08-14T09:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-question" } }),
      JSON.stringify(questionCall),
    ].join("\n"));
    await writeFile(answeredInputPath, [
      sessionMeta("answered-input"),
      JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-answered" } }),
      JSON.stringify(questionCall),
      JSON.stringify({
        timestamp: "2026-08-14T10:02:00.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-question", output: "{}" },
      }),
    ].join("\n"));
    await writeFile(failedPath, [
      sessionMeta("failed"),
      JSON.stringify({ timestamp: "2026-08-14T11:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-failed" } }),
      JSON.stringify({
        timestamp: "2026-08-14T11:05:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-failed",
          error: { message: "502 Bad Gateway: Provider unreachable" },
        },
      }),
    ].join("\n"));

    const rows = await annotateDesktopTaskActivity([
      { id: "running", path: runningPath },
      { id: "completed", path: completedPath },
      { id: "needs-input", path: needsInputPath },
      { id: "answered-input", path: answeredInputPath },
      { id: "failed", path: failedPath },
    ], 50, { codexHome: directory, isThreadActive: async () => true });

    expect(rows[0]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteLatestTurnId: "turn-running",
      androidRemoteLatestTurnAt: "2026-08-14T08:00:00.000Z",
    });
    expect(rows[1]).toMatchObject({
      androidRemoteLatestTurnState: "completed",
      androidRemoteLatestTurnId: "turn-complete",
      androidRemoteLatestTurnAt: "2026-08-14T06:05:00.000Z",
    });
    expect(rows[2]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteWaitingOnUserInput: true,
      androidRemotePendingUserInput: {
        itemId: "input-item-1",
        callId: "call-question",
        questions: [{
          id: "platform_scope",
          header: "Platform",
          question: "Which platform should the UI test plan cover?",
          options: [
            { label: "Android (Recommended)", description: "Focus on Android UI tests." },
            { label: "All platforms", description: "Cover every relevant platform." },
          ],
        }],
      },
    });
    expect(rows[3]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteWaitingOnUserInput: false,
    });
    expect(rows[4]).toMatchObject({
      androidRemoteLatestTurnState: "error",
      androidRemoteLatestTurnId: "turn-failed",
      androidRemoteLatestTurnAt: "2026-08-14T11:05:00.000Z",
      androidRemoteLatestTurnError: "502 Bad Gateway: Provider unreachable",
    });

    const shell = projectCodexShellSnapshot(rows, 1);
    expect((shell.threads as Array<Record<string, unknown>>)[0]).toMatchObject({
      latestTurn: { turnId: "turn-running", state: "running" },
      session: { status: "running", activeTurnId: "turn-running" },
    });
    expect((shell.threads as Array<Record<string, unknown>>)[1]).toMatchObject({
      latestTurn: { turnId: "turn-complete", state: "completed" },
      session: { status: "idle", activeTurnId: null },
    });
    expect((shell.threads as Array<Record<string, unknown>>)[2]).toMatchObject({
      hasPendingUserInput: true,
    });
    expect((shell.threads as Array<Record<string, unknown>>)[3]).toMatchObject({
      hasPendingUserInput: false,
    });
    expect((shell.threads as Array<Record<string, unknown>>)[4]).toMatchObject({
      latestTurn: { turnId: "turn-failed", state: "error" },
      session: {
        status: "error",
        activeTurnId: null,
        lastError: "502 Bad Gateway: Provider unreachable",
      },
    });
  });

  test("does not invent an interruption from an inactive owner view", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencodex-desktop-stale-activity-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = join(directory, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const stalePath = join(sessionsRoot, "stale.jsonl");
    const activePath = join(sessionsRoot, "active.jsonl");
    const needsInputPath = join(sessionsRoot, "needs-input.jsonl");
    const taskStarted = JSON.stringify({
      timestamp: "2026-08-14T08:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-stale" },
    });
    await writeFile(stalePath, [
      JSON.stringify({
        timestamp: "2026-08-14T07:59:00.000Z",
        type: "session_meta",
        payload: { id: "inactive" },
      }),
      taskStarted,
    ].join("\n"));
    await writeFile(activePath, [
      JSON.stringify({
        timestamp: "2026-08-14T07:59:00.000Z",
        type: "session_meta",
        payload: { id: "active" },
      }),
      taskStarted,
    ].join("\n"));
    await writeFile(needsInputPath, [
      JSON.stringify({
        timestamp: "2026-08-14T07:59:00.000Z",
        type: "session_meta",
        payload: { id: "needs-input" },
      }),
      taskStarted,
      JSON.stringify({
        timestamp: "2026-08-14T08:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "input-item",
          name: "request_user_input",
          call_id: "input-call",
          arguments: JSON.stringify({
            questions: [{ id: "scope", question: "Which scope?", options: [{ label: "Android" }] }],
          }),
        },
      }),
    ].join("\n"));
    const probes: string[] = [];

    const rows = await annotateDesktopTaskActivity([
      { id: "inactive", path: stalePath, updatedAt: Date.parse("2026-08-14T08:01:00.000Z") / 1_000 },
      { id: "active", path: activePath, updatedAt: Date.parse("2026-08-14T08:01:00.000Z") / 1_000 },
      { id: "needs-input", path: needsInputPath, updatedAt: Date.parse("2026-08-14T08:01:00.000Z") / 1_000 },
    ], 50, {
      now: () => Date.parse("2026-08-14T10:00:00.000Z"),
      codexHome: directory,
      isThreadActive: async threadId => {
        probes.push(threadId);
        return threadId === "active";
      },
    });

    expect(rows[0]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteLatestTurnId: "turn-stale",
      androidRemoteLatestTurnAt: "2026-08-14T08:00:00.000Z",
      androidRemoteWaitingOnUserInput: false,
      androidRemoteActivityUnverified: true,
    });
    expect((projectCodexShellSnapshot(rows, 1).threads as unknown[])[0]).toMatchObject({
      latestTurn: null,
      session: { status: "error", activeTurnId: "turn-stale" },
    });
    expect(rows[1]).toMatchObject({ androidRemoteLatestTurnState: "running" });
    expect(rows[2]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteWaitingOnUserInput: true,
    });
    // Activity inspection is intentionally parallel across sidebar rows; only the set of
    // authoritative probes is part of the contract, not completion order.
    expect([...probes].sort()).toEqual(["active", "inactive"]);
  });

  test("does not keep an old running marker when Desktop state is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencodex-windows-unknown-activity-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = join(directory, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const id = "unknown-activity-task";
    const path = join(sessionsRoot, `rollout-${id}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ timestamp: "2026-09-06T08:00:00.000Z", type: "session_meta", payload: { id } }),
      JSON.stringify({ timestamp: "2026-09-06T08:01:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } }),
    ].join("\n") + "\n");
    const result = await annotateDesktopTaskActivity([{ id, path, updatedAt: Date.parse("2026-09-06T08:02:00.000Z") }], 1, {
      codexHome: directory,
      platform: "win32",
      now: () => Date.parse("2026-09-06T08:02:00.000Z"),
      isThreadActive: async () => null,
    });
    expect(result[0]).toMatchObject({
      androidRemoteLatestTurnState: "running",
      androidRemoteActivityUnverified: true,
      androidRemoteLatestTurnError: "The latest task state could not be verified.",
    });
    expect((projectCodexShellSnapshot(result, 1).threads as unknown[])[0]).toMatchObject({
      latestTurn: null,
      session: {
        status: "error",
        activeTurnId: "old-turn",
        lastError: "Task status is unavailable. Reconnect to check whether it is still running.",
      },
    });
  });

  test.each(["reasoning", "dynamic_tool_call", "dynamic_tool_call_output", "dynamicToolCall", "dynamicToolCallOutput"])("recognizes recent %s progress without requiring a reachable status handler", async type => {
    const directory = await mkdtemp(join(tmpdir(), "rmx-task-progress-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "sessions"));
    const path = join(directory, "sessions", "progress.jsonl");
    const startedAt = "2026-09-29T08:00:00.000Z";
    const progressedAt = "2026-09-29T08:10:00.000Z";
    await writeFile(path, [
      { type: "session_meta", payload: { id: "progress" } },
      { timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-progress" } },
      { timestamp: progressedAt, type: "response_item_event", payload: { type } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    let now = Date.parse(progressedAt) + 5_000;
    let probes = 0;
    const read = async () => (await annotateDesktopTaskActivity([{ id: "progress", path }], 1, {
      codexHome: directory, now: () => now,
      isThreadActive: async () => { probes++; return null; },
    }))[0]!;
    expect(await read()).toMatchObject({ androidRemoteLatestTurnState: "running", androidRemoteLatestProgressAt: progressedAt });
    expect(probes).toBe(0);
    now += 35_000;
    expect((await read()).androidRemoteActivityUnverified).toBe(true);
    await appendFile(path, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "response_item", payload: { type } }) + "\n");
    expect((await read()).androidRemoteActivityUnverified).toBeUndefined();
    await appendFile(path, JSON.stringify({ timestamp: new Date(now + 1).toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-progress" } }) + "\n");
    expect((await read()).androidRemoteLatestTurnState).toBe("completed");
  });

  test("Windows keeps recent real work running across cold and incremental reads, then respects a real stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencodex-live-progress-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "sessions"));
    const path = join(directory, "sessions", "progress.jsonl");
    const startedAt = "2026-09-08T08:00:00.000Z";
    const event = (timestamp: string, type: string, turnId = "live-turn") => JSON.stringify({
      timestamp, type: "event_msg", payload: { type, turn_id: turnId },
    }) + "\n";
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "progress" } }) + "\n"
      + event(startedAt, "task_started")
      + event("2026-09-08T08:10:00.000Z", "agent_reasoning"));
    let now = Date.parse("2026-09-08T08:10:05.000Z");
    let probes = 0;
    const options = {
      codexHome: directory, platform: "win32" as const, now: () => now,
      isThreadActive: async () => { probes++; return false; },
    };
    const read = async () => (await annotateDesktopTaskActivity([{ id: "progress", path }], 1, options))[0]!;
    const cold = await read();
    expect(cold).toMatchObject({ androidRemoteLatestTurnState: "running", androidRemoteLatestTurnAt: startedAt });
    expect(cold.androidRemoteActivityUnverified).toBeUndefined();
    expect(probes).toBe(0);
    const interruptedRead = {
      ...cold,
      turns: [{ id: "live-turn", status: "interrupted", startedAt: Date.parse(startedAt) / 1000,
        completedAt: null, items: [], error: { message: "stream disconnected before completion" } }],
    };
    const detail = projectCodexThreadDetail(interruptedRead, 1).thread as Record<string, unknown>;
    expect(detail).toMatchObject({
      latestTurn: { state: "running", turnId: "live-turn" },
      session: { status: "running", activeTurnId: "live-turn" },
    });
    // Recent work cannot undo a dated stop, a completed reply, an interruption
    // newer than the work, an unknown observation, or a later different turn.
    for (const overrides of [
      { completedAt: Date.parse("2026-09-08T08:10:01.000Z") / 1000 },
      { status: "completed" },
      { updatedAt: Date.parse("2026-09-08T08:10:01.000Z") / 1000 },
      { startedAt: null },
    ]) {
      expect((projectCodexThreadDetail({ ...interruptedRead,
        turns: [{ ...interruptedRead.turns[0], ...overrides }],
      }, 1).thread as { session: { status: string } }).session.status).toBe("idle");
    }
    const uncertain = projectCodexThreadDetail({ ...interruptedRead, androidRemoteActivityUnverified: true }, 1)
      .thread as { session: { status: string; lastError: string }; latestTurn: unknown };
    expect(uncertain.session.status).toBe("error");
    expect(uncertain.session.lastError).toContain("Task status is unavailable");
    expect(uncertain.latestTurn).toBeNull();
    expect((projectCodexThreadDetail({ ...interruptedRead,
      turns: [...interruptedRead.turns, { id: "later-turn", status: "completed", items: [] }],
    }, 1).thread as { session: { status: string } }).session.status).toBe("idle");

    // Make the old marker fall outside the incremental overlap window.
    await appendFile(path, JSON.stringify({ type: "response_item", timestamp: "2026-09-08T08:11:00.000Z",
      payload: { type: "custom_tool_call_output", output: "x".repeat(2048) },
    }) + "\n");
    now = Date.parse("2026-09-08T08:11:05.000Z");
    expect((await read()).androidRemoteActivityUnverified).toBeUndefined();
    expect((await read()).androidRemoteActivityUnverified).toBeUndefined(); // unchanged-size cache
    expect(probes).toBe(0);

    // A new metadata/user record is not evidence that the assistant is working.
    now += 60_000;
    await appendFile(path, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "response_item",
      payload: { type: "message", role: "user", content: [] },
    }) + "\n");
    expect((await read()).androidRemoteActivityUnverified).toBe(true);
    expect(probes).toBe(1);

    await appendFile(path, event(new Date(now).toISOString(), "turn_aborted")
      + event(new Date(now + 1).toISOString(), "agent_message"));
    expect(await read()).toMatchObject({ androidRemoteLatestTurnState: "interrupted" });
    await appendFile(path, event(new Date(now + 2).toISOString(), "task_started", "new-turn"));
    expect(await read()).toMatchObject({ androidRemoteLatestTurnState: "running", androidRemoteLatestTurnId: "new-turn" });
    await appendFile(path, event(new Date(now + 3).toISOString(), "task_complete", "new-turn"));
    expect(await read()).toMatchObject({ androidRemoteLatestTurnState: "completed", androidRemoteLatestTurnId: "new-turn" });
  });
});
