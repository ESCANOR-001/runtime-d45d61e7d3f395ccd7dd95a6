import { afterEach, expect, spyOn, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import * as remoteCheck from "../src/update/remote-check";
import * as background from "../src/update/background";
import * as scheduler from "../src/update/auto-scheduler";
import type { OcxConfig } from "../src/types";
import { createDesktopUpdateRoutes } from "../src/android-remote/desktop-updates";

const previous = process.env.REMODEX_CONNECT_ONLY;
afterEach(() => {
  if (previous === undefined) delete process.env.REMODEX_CONNECT_ONLY;
  else process.env.REMODEX_CONNECT_ONLY = previous;
});

test("Connect phone update routes cannot start an installer or inspect the legacy scheduler", async () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  let checks = 0;
  const route = createDesktopUpdateRoutes({
    check: async () => {
      checks += 1;
      return { currentVersion: "1.2.18", latestVersion: "1.2.19", channel: "latest", installer: "npm",
        updateAvailable: true, canUpdate: true, command: "must not execute", releaseNotesUrl: "",
        releaseNotes: null, checkedAt: "2026-09-23T12:00:00Z" };
    },
    readJob: () => { throw new Error("must not read legacy jobs"); },
    start: () => { throw new Error("must not install legacy package"); },
  });
  const wake = spyOn(background, "requestBackgroundUpdateCheck").mockImplementation(() => { throw new Error("must not wake installer"); });
  const status = spyOn(scheduler, "publicAutomaticUpdateStatus").mockImplementation(() => { throw new Error("must not inspect scheduler"); });
  const idle = () => ({ known: true, running: 0 });
  try {
    const response = await route(new Request("http://localhost/api/desktop-update/check"), idle);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canUpdate: false, checkOnly: true, job: null,
      automaticUpdates: { supported: false, enabled: false }, background: { status: "disabled" } });
    const progress = await route(new Request("http://localhost/api/desktop-update/status"), idle);
    expect(progress.status).toBe(200);
    expect(await progress.json()).toMatchObject({ job: null, starting: false, checkOnly: true });
    const install = await route(new Request("http://localhost/api/desktop-update/run", {
      method: "POST", body: JSON.stringify({ confirm: true }),
    }), idle);
    expect(install.status).toBe(409);
    expect(await install.json()).toMatchObject({ code: "connect_check_only" });
    expect(checks).toBe(1);
    expect(wake).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  } finally { wake.mockRestore(); status.mockRestore(); }
});

test("Connect checks the requested npm channel without activating installation or the scheduler", async () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  const check = spyOn(remoteCheck, "checkRemoteUpdate").mockResolvedValue({
    currentVersion: "1.2.18", latestVersion: "1.2.19", channel: "preview", installer: "npm",
    updateAvailable: true, canUpdate: true, command: "npm install -g @remodex/rmx@1.2.19",
    releaseNotesUrl: "", releaseNotes: "Release details", checkedAt: "2026-09-23T12:00:00Z",
  });
  const wake = spyOn(background, "requestBackgroundUpdateCheck").mockImplementation(() => { throw new Error("must not wake installer"); });
  const status = spyOn(scheduler, "publicAutomaticUpdateStatus").mockImplementation(() => { throw new Error("must not inspect legacy scheduler"); });
  const config = { providers: {}, defaultProvider: "openai", port: 10110 } as OcxConfig;
  try {
    const url = new URL("http://localhost:10110/api/update/check?tag=preview");
    const response = await handleManagementAPI(new Request(url, { headers: { Host: url.host } }), url, config);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ latestVersion: "1.2.19", canUpdate: false, command: "", checkOnly: true, automaticUpdates: { supported: false, enabled: false }, releaseNotes: "Release details" });
    expect(check).toHaveBeenCalledWith("preview", true);
    expect(wake).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    const invalid = new URL("http://localhost:10110/api/update/check?tag=invalid");
    expect((await handleManagementAPI(new Request(invalid, { headers: { Host: invalid.host } }), invalid, config))?.status).toBe(400);
    expect(check).toHaveBeenCalledTimes(1);
    const install = new URL("http://localhost:10110/api/update/run");
    expect((await handleManagementAPI(new Request(install, { method: "POST" }), install, config))?.status).toBe(404);
  } finally {
    check.mockRestore(); wake.mockRestore(); status.mockRestore();
  }
});
