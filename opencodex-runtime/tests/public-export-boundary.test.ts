import { expect, test } from "bun:test";

test("the public Antigravity module does not embed Google OAuth client credentials", async () => {
  const source = await Bun.file(new URL("../src/oauth/google-antigravity.ts", import.meta.url)).text();
  expect(source).not.toMatch(/GOCSPX-[A-Za-z0-9_-]+/);
  expect(source).not.toMatch(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/);
  expect(source).toContain("process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID");
  expect(source).toContain("process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET");
});
