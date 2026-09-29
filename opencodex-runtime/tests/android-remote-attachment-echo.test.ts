import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";
import { DesktopSessionRecordProjector } from "../src/android-remote/desktop-session-stream";
import { projectCodexThreadDetail } from "../src/android-remote/projection";

type Row = Record<string, any>;

// The same saved-record format is consumed on every host. These are path-format
// regressions, not a substitute for running the suite on each operating system.
for (const directory of ["C:\\Users\\example\\uploads", "/home/example/uploads", "\\\\host\\share\\uploads"]) {
  for (const kind of ["image", "file"] as const) {
    describe(`${kind} echoes under ${directory}`, () => {
      const path = `${directory}${directory.startsWith("/") ? "/" : "\\"}${kind === "image" ? "photo.jpg" : "notes.txt"}`;
      const prompt = "Explain this attachment.";
      const content = kind === "image"
        ? [{ type: "text", text: prompt }, { type: "local_image", path }]
        : [{ type: "text", text: `${prompt}\n\nFiles uploaded from Android and staged on this PC:\n- ${path}` }];
      function submission(suffix: string): Row[] {
        return [
          { type: "response_item", payload: {
            type: "message", role: "user", id: `response-${suffix}`,
            content: kind === "image" ? [
              { type: "input_text", text: prompt },
              { type: "input_text", text: `<image name=[Image #1] path="${path}">` },
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
              { type: "input_text", text: "</image>" },
            ] : [{ type: "input_text", text: content[0]!.text }],
          } },
          { type: "response_item", payload: {
            type: "message", role: "developer", id: `notice-${suffix}`,
            content: [{ type: "input_text", text: "<image_resize_notice>Internal attachment notice</image_resize_notice>" }],
          } },
          { type: "event_msg", payload: {
            type: "item_completed", turn_id: "turn-1", item: {
              type: "UserMessage", id: `structured-${suffix}`, client_id: `client-${suffix}`, content,
            },
          } },
        ];
      }

      test("live events keep the client identity across an internal notice", () => {
        const events: Row[] = [];
        const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
        projector.consume({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } });
        for (const row of [...submission("a"), ...submission("b")]) projector.consume(row);
        projector.consume({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } });
        const users = events.filter(event => event.params?.item?.type === "userMessage");
        expect(users.map(event => event.params.item.clientId)).toEqual(["client-a", "client-b"]);
        expect(JSON.stringify(users)).not.toContain("Internal attachment notice");
        expect(JSON.stringify(users)).toContain(path.replaceAll("\\", "\\\\"));
      });

      test("saved history shows one bubble per submission and retains attachments", async () => {
        const home = await mkdtemp(join(tmpdir(), "remodex-attachment-echo-"));
        try {
          await mkdir(join(home, "sessions"));
          const source = join(home, "sessions", "rollout-test.jsonl");
          const records = [
            { type: "session_meta", payload: { id: "thread-1" } },
            { type: "turn_context", payload: { turn_id: "turn-1" } },
            ...submission("a"), ...submission("b"),
            { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
          ];
          await writeFile(source, records.map(row => JSON.stringify(row)).join("\n") + "\n");
          const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
          const recovered = await recovery.enrichThread({ id: "thread-1", path: source, turns: [] });
          const items = (recovered.turns as Row[])[0]!.items as Row[];
          expect(items.map(item => item.clientId)).toEqual(["client-a", "client-b"]);
          if (kind === "image") expect(items[0]!.content[1]).toEqual({ type: "localImage", path });
          const projected = projectCodexThreadDetail(recovered, 1) as Row;
          const messages = projected.thread.messages as Row[];
          expect(messages.map(message => message.id)).toEqual(["client-a", "client-b"]);
          for (const message of messages) expect(message.text).toContain(path);
          expect(JSON.stringify(messages)).not.toContain("Internal attachment notice");
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      });
    });
  }
}
