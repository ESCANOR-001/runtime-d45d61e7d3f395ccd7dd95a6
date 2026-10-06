import { expect, test } from "bun:test";
import { selectConnectSchedulerTask } from "../src/service";

const absent = { status: "absent" } as const;
const present = { status: "present" } as const;
test("Connect reuses its owned old task and creates a new task only when neither exists", () => {
  expect(selectConnectSchedulerTask(absent, present, name => name === "opencodex-proxy")).toBe("opencodex-proxy");
  expect(selectConnectSchedulerTask(present, absent, name => name === "remodex-connect")).toBe("remodex-connect");
  expect(selectConnectSchedulerTask(absent, absent, () => { throw new Error("No task to verify"); })).toBe("remodex-connect");
});
test("Connect refuses duplicate tasks, unknown manager status, and another profile's task", () => {
  expect(() => selectConnectSchedulerTask(present, present, () => true)).toThrow("Both");
  expect(() => selectConnectSchedulerTask({ status: "unknown", detail: "denied" }, absent, () => true)).toThrow("verify");
  expect(() => selectConnectSchedulerTask(absent, present, () => false)).toThrow("another profile");
  expect(() => selectConnectSchedulerTask(present, absent, () => false)).toThrow("another profile");
});
