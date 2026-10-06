import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishServiceSetup, readServiceSetup, serviceSetupState, startServiceSetup } from "../src/connect/service-setup";

const previous = process.env.OPENCODEX_HOME;
let home: string | undefined;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
  if (home) rmSync(home, { recursive: true, force: true });
});
const prepare = () => {
  home = mkdtempSync(join(tmpdir(), "connect-service-job-"));
  process.env.OPENCODEX_HOME = home;
  return join(home, "connect-service-setup.json");
};

test("service setup is detached and hidden, survives server replacement, and rejects duplicate attempts", async () => {
  prepare();
  let calls = 0;
  await startServiceSetup("install", ((_runtime, args, options) => {
    calls++;
    expect(args.at(-1)).toBe("install");
    expect(args[0]).toEndWith("service-worker.ts");
    expect(options).toMatchObject({ detached: true, windowsHide: true, shell: false });
    expect(options.env.OCX_SERVICE).toBeUndefined();
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as never);
  expect(readServiceSetup()?.pid).toBe(process.pid);
  expect(serviceSetupState()).toBe("running");
  await expect(startServiceSetup("repair", (() => { throw new Error("must not spawn"); }) as never)).rejects.toThrow("pending");
  expect(calls).toBe(1);
  finishServiceSetup(readServiceSetup()!.id, "blocked");
  expect(serviceSetupState()).toBe("blocked");
  await expect(startServiceSetup("install")).rejects.toThrow("pending");
});

test("a completed attempt stays completed even when its PID is still alive or reused", () => {
  const path = prepare();
  for (const [status, expected] of [["succeeded", "idle"], ["failed", "failed"]]) {
    writeFileSync(path, JSON.stringify({ id: "finished", pid: process.pid, startedAt: Date.now(), status }));
    expect(serviceSetupState()).toBe(expected);
  }
});

test("a failed worker spawn releases the attempt and malformed state fails closed", async () => {
  const path = prepare();
  await expect(startServiceSetup("install", (() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  }) as never)).rejects.toThrow("spawn failed");
  expect(serviceSetupState()).toBe("idle");
  writeFileSync(path, "invalid");
  expect(serviceSetupState()).toBe("blocked");
  await expect(startServiceSetup("install")).rejects.toThrow("pending");
});
