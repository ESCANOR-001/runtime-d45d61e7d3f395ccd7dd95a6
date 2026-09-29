import { afterEach, describe, expect, test } from "bun:test";
import {
  clearReleaseNotesCacheForTests,
  fetchReleaseNotesForVersion,
} from "../src/update/release-notes";

afterEach(() => clearReleaseNotesCacheForTests());

describe("npm update release notes", () => {
  test("reads the exact GitHub Release body", async () => {
    let requested = "";
    const body = await fetchReleaseNotesForVersion("1.0.5", (async input => {
      requested = String(input);
      return Response.json({ tag_name: "v1.0.5", body: "- Faster onboarding\n- Clearer errors" });
    }) as typeof fetch);

    expect(requested.endsWith("/releases/tags/v1.0.5")).toBe(true);
    expect(body).toBe("- Faster onboarding\n- Clearer errors");
  });

  test("rejects a mismatched release and fails softly when GitHub is unavailable", async () => {
    const mismatched = await fetchReleaseNotesForVersion("1.0.5", (async () => (
      Response.json({ tag_name: "v1.0.6", body: "wrong version" })
    )) as typeof fetch);
    expect(mismatched).toBeNull();

    const unavailable = await fetchReleaseNotesForVersion("1.0.5", (async () => (
      new Response("unavailable", { status: 503 })
    )) as typeof fetch);
    expect(unavailable).toBeNull();
  });

  test("rejects malformed versions before making a request", async () => {
    let called = false;
    const body = await fetchReleaseNotesForVersion("../../latest", (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch);

    expect(body).toBeNull();
    expect(called).toBe(false);
  });
});
