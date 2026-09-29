import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceTextFile } from "../src/android-remote/file-preview";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rmx-file-preview-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  return { root, workspace };
}

describe("workspace text previews", () => {
  test("reads actual contents, including empty and Unicode files", async () => {
    const { workspace } = await fixture();
    await writeFile(join(workspace, "notes.txt"), "Hello 🌍\n");
    expect(await readWorkspaceTextFile(workspace, "notes.txt")).toMatchObject({ content: "Hello 🌍\n", truncated: false, path: "notes.txt" });
    await writeFile(join(workspace, "empty.txt"), "");
    expect((await readWorkspaceTextFile(workspace, "empty.txt")).content).toBe("");
  });
  test("rejects traversal, outside absolute paths and symlink escapes", async () => {
    const { root, workspace } = await fixture();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside");
    for (const path of ["../outside.txt", outside]) {
      await expect(readWorkspaceTextFile(workspace, path)).rejects.toThrow("project folder");
    }
    const outsideFolder = join(root, "outside-folder");
    await mkdir(outsideFolder);
    await writeFile(join(outsideFolder, "notes.txt"), "outside");
    await symlink(outsideFolder, join(workspace, "linked-folder"), process.platform === "win32" ? "junction" : "dir");
    await expect(readWorkspaceTextFile(workspace, "linked-folder/notes.txt")).rejects.toThrow("project folder");
  });
  test("rejects binary, non-UTF8, missing and directory targets", async () => {
    const { workspace } = await fixture();
    await writeFile(join(workspace, "binary.txt"), Buffer.from([0, 1, 2]));
    await writeFile(join(workspace, "invalid.txt"), Buffer.from([0xff]));
    for (const path of ["binary.txt", "invalid.txt", "missing.txt", "."]) {
      await expect(readWorkspaceTextFile(workspace, path)).rejects.toThrow();
    }
  });
  test("bounds large reads without splitting a UTF8 character", async () => {
    const { workspace } = await fixture();
    await writeFile(join(workspace, "large.txt"), "a".repeat(256 * 1024 - 1) + "🌍rest");
    const preview = await readWorkspaceTextFile(workspace, "large.txt");
    expect(preview.truncated).toBe(true);
    expect(preview.content).toBe("a".repeat(256 * 1024 - 1));
  });
});
