import { expect, spyOn, test } from "bun:test";
import { checkRegistryVersion, checkRemoteUpdate } from "../src/update/remote-check";

const noWait = async () => {};
const metadata = { name: "@remodex/rmx", version: "1.2.17" };

test("registry checks retry a transient connection failure once using the fixed npm endpoint", async () => {
  let calls = 0;
  const fetcher = (async (url, options) => {
    expect(url).toBe("https://registry.npmjs.org/%40remodex%2Frmx/latest");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    calls += 1;
    if (calls === 1) throw new TypeError("connection reset with private details");
    return Response.json(metadata);
  }) as typeof fetch;
  expect(await checkRegistryVersion("latest", fetcher, noWait)).toEqual({ version: "1.2.17" });
  expect(calls).toBe(2);
});

test("registry failures return bounded diagnostics without leaking raw errors", async () => {
  for (const error of [new TypeError("secret proxy URL"), new DOMException("private host", "TimeoutError")]) {
    let calls = 0;
    const result = await checkRegistryVersion("latest", (async () => { calls += 1; throw error; }) as typeof fetch, noWait);
    expect(result).toEqual({ version: null, error: { code: error.name === "TimeoutError" ? "timeout" : "network" } });
    expect(calls).toBe(2);
    expect(JSON.stringify(result)).not.toContain(error.message);
  }
});

test("registry HTTP failures cancel their bodies and only retry server failures", async () => {
  for (const status of [403, 404, 429, 503]) {
    let calls = 0;
    let cancellations = 0;
    const result = await checkRegistryVersion("latest", (async () => {
      calls += 1;
      return new Response(new ReadableStream({ cancel() { cancellations += 1; } }), { status });
    }) as typeof fetch, noWait);
    expect(result).toEqual({ version: null, error: { code: "http", status } });
    expect(calls).toBe(status === 503 ? 2 : 1);
    expect(cancellations).toBe(calls);
  }
});

test("registry validation rejects malformed, oversized and unrelated package metadata without retrying", async () => {
  for (const payload of ["null", "not json", JSON.stringify({ ...metadata, name: "other" }),
    JSON.stringify({ ...metadata, version: "../../bad" }), "x".repeat(512 * 1024 + 1)]) {
    let calls = 0;
    const result = await checkRegistryVersion("latest", (async () => {
      calls += 1;
      return new Response(payload);
    }) as typeof fetch, noWait);
    expect(result).toEqual({ version: null, error: { code: "invalid_response" } });
    expect(calls).toBe(1);
  }
});

test("remote update checks expose safe registry diagnostics to clients", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 429 }));
  try {
    const result = await checkRemoteUpdate("preview", true);
    expect(result.latestVersion).toBeNull();
    expect(result.registryError).toEqual({ code: "http", status: 429 });
    expect(result.canUpdate).toBe(false);
    fetcher.mockImplementation(async input => String(input).startsWith("https://registry.npmjs.org/")
      ? Response.json(metadata) : new Response(null, { status: 404 }));
    const retry = checkRemoteUpdate("preview", true);
    expect(checkRemoteUpdate("preview", true)).toBe(retry);
    const recovered = await retry;
    expect(recovered.latestVersion).toBe(metadata.version);
    expect(recovered.registryError).toBeUndefined();
    const callsAfterRecovery = fetcher.mock.calls.length;
    expect(await checkRemoteUpdate("preview", true)).toEqual(recovered);
    expect(fetcher.mock.calls.length).toBe(callsAfterRecovery);
  } finally {
    fetcher.mockRestore();
  }
});

test("source copies can discover newer releases without becoming installable", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(async input => {
    return String(input).startsWith("https://registry.npmjs.org/")
      ? Response.json({ name: "@remodex/rmx", version: "999.0.0" })
      : new Response(null, { status: 404 });
  });
  try {
    const result = await checkRemoteUpdate("latest", true);
    expect(result.latestVersion).toBe("999.0.0");
    expect(result.updateAvailable).toBe(true);
    expect(result.installer).toBe("source");
    expect(result.canUpdate).toBe(false);
  } finally { fetcher.mockRestore(); }
});
