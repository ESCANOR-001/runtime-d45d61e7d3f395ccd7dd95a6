import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { generatedImagePaths } from "../src/android-remote/generated-images";
import { normalizedCompletedItem } from "../src/android-remote/desktop-thread-item";
import { DesktopSessionRecordProjector } from "../src/android-remote/desktop-session-stream";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";
import { annotateDesktopTaskActivity } from "../src/android-remote/desktop-workspace-state";
import { projectCodexThreadDetail } from "../src/android-remote/projection";
import { AndroidRemoteAssetStore } from "../src/android-remote/assets";

const started = "2026-09-29T10:00:00.000Z";
const images = ["/tmp/image one.png", "/tmp/image-two.png", "/tmp/image-three.png"];
const rows = [
  { type: "session_meta", payload: { id: "images" } },
  { timestamp: started, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: started, type: "response_item", payload: { type: "custom_tool_call", name: "exec", id: "call-1", call_id: "call-1", input: "const result = await tools.image_gen__imagegen({prompt: 'draw'}); generatedImage(result);" } },
  ...images.map((path, index) => ({ timestamp: "2026-09-29T10:02:00.000Z", type: "event_msg", payload: {
    type: "item_completed", turn_id: "turn-1", item: { type: "Extension", kind: "image_gen.generation", id: `image-${index}`, status: "completed", savedPath: path, result: "private-base64-never-send", revisedPrompt: "private prompt" },
  } })),
  { timestamp: "2026-09-29T10:02:01.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "text", text: "Script completed" }] } },
];

test("normalizes Desktop image extensions without binary data or prompts", () => {
  const item = normalizedCompletedItem(rows[3]!.payload.item, true);
  expect(item).toEqual({ type: "imageGeneration", id: "image-0", status: "completed", generatedImages: [images[0]] });
  const direct = projectCodexThreadDetail({ id: "images", turns: [{ id: "turn-1", status: "completed", items: [rows[3]!.payload.item] }] }, 1, { compactCompletedWork: true }) as any;
  expect(direct.thread.activities[0].payload.data.generatedImages).toEqual([images[0]]);
  expect(generatedImagePaths([{ text: `Generated images are saved to /tmp as ${images[0]} by default.` }, { image_url: "data:image/png;base64,secret" }])).toEqual([images[0]]);
});

test("streams one image-generation activity with three lazy image references", () => {
  const events: any[] = [];
  const projector = new DesktopSessionRecordProjector("images", event => events.push(event));
  rows.forEach(row => projector.consume(row));
  const activities = events.filter(event => event.params?.item?.type === "imageGeneration");
  expect(activities[0].method).toBe("item/started");
  expect(new Set(activities.map(event => event.params.item.id)).size).toBe(1);
  expect(activities.at(-1).params.item).toMatchObject({ status: "completed", generatedImages: images });
  expect(JSON.stringify(activities)).not.toContain("private-base64");
});

test("recovers the same image gallery after reconnect and bounds quiet generation status", async () => {
  const home = await mkdtemp(join(tmpdir(), "rmx-images-"));
  try {
    await mkdir(join(home, "sessions"));
    const path = join(home, "sessions", "images.jsonl");
    await writeFile(path, rows.slice(0, 3).map(row => JSON.stringify(row)).join("\n") + "\n");
    const thread = { id: "images", path, status: { type: "notLoaded" } };
    let now = Date.parse(started) + 120_000;
    const options = { codexHome: home, now: () => now, isThreadActive: async () => null };
    expect((await annotateDesktopTaskActivity([thread], 1, options))[0]?.androidRemoteActivityUnverified).toBeUndefined();
    now += 600_000;
    expect((await annotateDesktopTaskActivity([thread], 1, options))[0]?.androidRemoteActivityUnverified).toBe(true);
    await appendFile(path, rows.slice(3).map(row => JSON.stringify(row)).join("\n") + "\n");
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const restored = await recovery.enrichThread({ ...thread, turns: [] });
    const detail = projectCodexThreadDetail(restored, 1) as any;
    const activities = detail.thread.activities.filter((activity: any) => activity.payload?.itemType === "image-generation");
    expect(activities).toHaveLength(1);
    expect(activities[0].payload.data.generatedImages).toEqual(images);
    await appendFile(path, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }) + "\n");
    expect((await annotateDesktopTaskActivity([thread], 1, options))[0]?.androidRemoteLatestTurnState).toBe("interrupted");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("keeps a yielded image generator active until its wait result completes", () => {
  const events: any[] = [];
  const projector = new DesktopSessionRecordProjector("images", event => events.push(event));
  rows.slice(0, 3).forEach(row => projector.consume(row));
  projector.consume({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "Script running with cell ID 17" } });
  expect(events.filter(event => event.method === "item/completed")).toHaveLength(0);
  projector.consume({ type: "response_item", payload: { type: "function_call", name: "wait", call_id: "wait-1", arguments: JSON.stringify({ cell_id: "17" }) } });
  projector.consume({ type: "response_item", payload: { type: "function_call_output", call_id: "wait-1", output: [{ type: "text", text: `Generated images are saved to /tmp as ${images[0]} by default.` }] } });
  expect(events.at(-1).params.item).toMatchObject({ id: "call-1", status: "completed", generatedImages: [images[0]] });
});

test("serves small thumbnails only through valid exact-file capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "rmx-thumbnails-"));
  try {
    const path = join(root, "generated.png");
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "blue" } }).png().toFile(path);
    let now = 0;
    const assets = new AndroidRemoteAssetStore(() => now);
    const ticket = await assets.issueWorkspaceImage({ workspaceRoot: root, path });
    const thumbnail = await assets.thumbnailResponse(ticket.relativeUrl + "/thumbnail", "GET");
    const bytes = await thumbnail!.arrayBuffer();
    expect(thumbnail!.headers.get("Content-Type")).toBe("image/webp");
    expect((await sharp(bytes).metadata()).width).toBe(256);
    expect(assets.response(ticket.relativeUrl, "GET")!.headers.get("Content-Type")).toBe("image/png");
    expect((await assets.thumbnailResponse(ticket.relativeUrl + "/thumbnail", "POST"))!.status).toBe(405);
    now = ticket.expiresAt + 1;
    expect((await assets.thumbnailResponse(ticket.relativeUrl + "/thumbnail", "GET"))!.status).toBe(404);
    expect((await assets.thumbnailResponse("/api/android-remote/assets/bad/thumbnail", "GET"))!.status).toBe(404);
  } finally { await rm(root, { recursive: true, force: true }); }
});
