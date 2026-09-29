import { expect, test } from "bun:test";

const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const action = await Bun.file(new URL("../src/components/sidebar-update-action.tsx", import.meta.url)).text();
const data = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
const dialog = await Bun.file(new URL("../src/pages/dashboard-dialogs.tsx", import.meta.url)).text();
const shared = await Bun.file(new URL("../src/pages/dashboard-shared.ts", import.meta.url)).text();
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

test("the Connect sidebar retains read-only update checks without installing the legacy package", () => {
  expect(app).toContain('import { SidebarUpdateAction } from "./components/sidebar-update-action"');
  expect(app).toContain("<SidebarUpdateAction");
  expect(action.match(/<button/g)?.length).toBe(1);
  expect(action).toContain("onClick={onOpenUpdate}");
  expect(action).toContain("/api/update/check");
  expect(action).toContain("AbortSignal.timeout(25_000)");
  expect(action).toContain('window.addEventListener("online", wake)');
  expect(action).not.toContain("/api/update/run");
  expect(action).not.toContain("desktop-update");
  expect(action).not.toContain("useKeyedClientResource");
});

test("the update dialog uses only the npm-package management API", () => {
  expect(data).toContain("/api/update/check?tag=${channel}");
  expect(data).toContain("/api/update/run");
  expect(data).not.toContain("/api/desktop-update");
  expect(dialog).toContain('t("dash.updateDesc")');
  expect(shared).toContain("releaseNotes?: string");
  expect(dialog).toContain("shouldShowReleaseNotes");
  expect(dialog).toContain('t("dash.updateWhatsNew"');
  expect(dialog).not.toContain("updateCheck.releaseNotesUrl");
  expect(dialog).not.toContain("dash.updateChangelog");
  expect(dialog).toContain("updateCheck?.lastInstalledAt ?? updateJob?.installedAt");
  expect(dialog).toContain('t("dash.updateInstalledAt", { time: installedAt })');
  expect(dialog).not.toContain("dash.desktopUpdate");
});

test("the dashboard waits for a completed and stable restart before reloading", () => {
  expect(data).toContain('import {\n  observeUpdateReconnect');
  expect(data).toContain('status: statusJob.status');
  expect(data).toContain("!updateReloadTriggeredRef.current");
  expect(data).toContain("healthOk: healthData.status === \"ok\"");
});

test("native desktop updater types and helpers are no longer dashboard state", () => {
  expect(shared).not.toContain("DesktopUpdate");
  expect(shared).not.toContain("desktopUpdate");
});

test("obsolete GitHub footer selectors remain removed", () => {
  expect(css).not.toContain(".sidebar-github-row");
  expect(css).not.toContain(".sidebar-github-link");
  expect(css).not.toContain(".sidebar-github-actions");
  expect(css).not.toContain(".sidebar-orb");
  expect(css).toContain(".sidebar-update-action");
});
