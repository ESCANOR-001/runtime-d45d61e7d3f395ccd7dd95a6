import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRemoteAssetStore } from "../src/android-remote/assets";

const cleanupFolders: string[] = [];

function temporaryFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  cleanupFolders.push(folder);
  return folder;
}

function pngBytes(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
}

afterEach(() => {
  for (const folder of cleanupFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("Android Remote image assets", () => {
  test("issues one exact image capability and serves it without caller path input", async () => {
    const root = temporaryFolder("ocx-android-asset-root-");
    const path = join(root, "phone preview.png");
    const bytes = pngBytes();
    writeFileSync(path, bytes);
    const assets = new AndroidRemoteAssetStore(() => 1_000);

    const issued = await assets.issueWorkspaceImage({
      workspaceRoot: root,
      path: "phone preview.png",
    });
    expect(issued.expiresAt).toBe(3_601_000);
    expect(issued.relativeUrl).toMatch(
      /^\/api\/android-remote\/assets\/[a-zA-Z0-9_-]{32}\/phone%20preview\.png$/,
    );

    const response = assets.response(issued.relativeUrl, "GET");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(bytes);
    expect(assets.response(issued.relativeUrl, "HEAD")?.status).toBe(200);
    expect(assets.response(issued.relativeUrl, "POST")?.status).toBe(405);
  });

  test("rejects files outside the task root, non-images, malformed tickets, and expiry", async () => {
    const root = temporaryFolder("ocx-android-asset-root-");
    const outside = temporaryFolder("ocx-android-asset-outside-");
    const image = join(root, "inside.png");
    const outsideImage = join(outside, "outside.png");
    const text = join(root, "notes.txt");
    writeFileSync(image, pngBytes());
    writeFileSync(outsideImage, pngBytes());
    writeFileSync(text, "not an image");
    let now = 5_000;
    const assets = new AndroidRemoteAssetStore(() => now);

    await expect(assets.issueWorkspaceImage({ workspaceRoot: root, path: outsideImage }))
      .rejects.toThrow("inside the selected Codex project folder");
    const referenced = await assets.issueAssistantReferencedImage(outsideImage);
    expect(assets.response(referenced.relativeUrl, "GET")?.status).toBe(200);
    await expect(assets.issueWorkspaceImage({ workspaceRoot: root, path: text }))
      .rejects.toThrow("PNG, JPEG, GIF, WebP, or BMP");
    expect(assets.response("/api/android-remote/assets/not-a-ticket/image.png", "GET")?.status)
      .toBe(404);
    expect(assets.response("/not-an-asset", "GET")).toBeNull();

    const issued = await assets.issueWorkspaceImage({ workspaceRoot: root, path: image });
    now = issued.expiresAt + 1;
    expect(assets.response(issued.relativeUrl, "GET")?.status).toBe(404);
  });
});
