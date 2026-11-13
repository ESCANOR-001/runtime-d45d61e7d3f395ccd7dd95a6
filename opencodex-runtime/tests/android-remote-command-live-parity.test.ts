import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRemoteGatewayController } from "../src/android-remote/gateway";
import { createAndroidRemoteStore } from "../src/android-remote/store";
import { projectCodexLiveTurnItem } from "../src/android-remote/projection";

test("live and inferred command rows converge by process identity in either arrival order", async () => {
  const root = mkdtempSync(join(tmpdir(), "command-live-parity-"));
  const controller = new AndroidRemoteGatewayController(createAndroidRemoteStore(root));
  const internal = controller as unknown as {
    upsertProjectedActivity(rows: unknown, row: Record<string, unknown>): Record<string, unknown>[];
  };
  const activity = (id: string, inferred: boolean, processId: string | null, turnId = "turn") =>
    projectCodexLiveTurnItem({ threadId: "thread", turnId, sequence: 1, createdAtMs: 1000, completed: false,
      item: { id, type: "commandExecution", command: inferred ? "check" : "/bin/bash -lc 'check'",
        commandActions: inferred ? undefined : [{ type: "unknown", command: "check" }], status: "inProgress", processId,
        androidRemoteInferredCommand: inferred } }).activity!;
  try {
    for (const nativeFirst of [false, true]) {
      let rows: Record<string, unknown>[] = [];
      const add = (id: string, inferred: boolean, process: string | null, turn = "turn") => {
        rows = internal.upsertProjectedActivity(rows, activity(id, inferred, process, turn));
      };
      if (nativeFirst) add("native", false, "42");
      add("wrapper", true, null);
      if (!nativeFirst) add("native", false, "42");
      expect(rows.map(row => row.id)).toEqual(["native"]);
      add("wrapper", true, "42");
      expect(rows.map(row => row.id)).toEqual(["native"]);
      add("wrapper", true, "42");
      expect(rows.map(row => row.id)).toEqual(["native"]);
      add("parallel-wrapper", true, "43");
      expect(rows).toHaveLength(2);
      add("parallel-native", false, "43");
      expect(rows.map(row => row.id)).toEqual(["native", "parallel-native"]);
      add("other-turn", true, "42", "next-turn");
      add("different-native", false, "42");
      expect(rows).toHaveLength(4);
    }
  } finally {
    await controller.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
