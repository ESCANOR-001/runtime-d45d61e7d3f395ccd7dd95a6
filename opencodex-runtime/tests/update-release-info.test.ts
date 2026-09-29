import { expect, test } from "bun:test";
import { fetchUpdateReleaseInfo, parseUpdateReleaseInfo } from "../src/update/release-info";
const info = { version: "1.2.3", urgency: "urgent", message: "Fixes reconnect failures.", affectedVersions: ["1.2.2"] };
test("urgent notices apply only to the verified release and affected installed version", () => {
  expect(parseUpdateReleaseInfo(info, "1.2.3", "1.2.2").urgency).toBe("urgent");
  expect(parseUpdateReleaseInfo(info, "1.2.4", "1.2.2").urgency).toBe("normal");
  expect(parseUpdateReleaseInfo(info, "1.2.3", "1.2.1").urgency).toBe("normal");
  expect(parseUpdateReleaseInfo({ ...info, affectedVersions: ["*"] }, "1.2.3", "1.2.1").urgency).toBe("urgent");
  expect(parseUpdateReleaseInfo({ ...info, message: "x".repeat(1001) }, "1.2.3", "1.2.2").urgency).toBe("normal");
});
test("missing or malformed release information does not block ordinary updates", async () => {
  const fake = (response: Response) => (async () => response) as unknown as typeof fetch;
  expect((await fetchUpdateReleaseInfo("1.2.3", "1.2.2", fake(new Response("", {status:404})))).urgency).toBe("normal");
  expect((await fetchUpdateReleaseInfo("1.2.3", "1.2.2", fake(new Response("bad json")))).urgency).toBe("normal");
  expect((await fetchUpdateReleaseInfo("1.2.3", "1.2.2", fake(Response.json(info)))).urgency).toBe("urgent");
});
