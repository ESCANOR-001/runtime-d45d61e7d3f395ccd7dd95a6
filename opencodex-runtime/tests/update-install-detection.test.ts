import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkForUpdate } from "../src/update/job";
import { detectInstallAt, PKG, updateCommandStr } from "../src/update/index";

describe("npm package update detection", () => {
  test("recognizes the published package under a Windows npm prefix", () => {
    const moduleDirectory = String.raw`C:\Users\Example\AppData\Roaming\npm\node_modules\@remodex\rmx\src\update`;
    expect(detectInstallAt(moduleDirectory)).toBe("npm");
  });

  test("recognizes the package under a POSIX npm prefix", () => {
    expect(detectInstallAt("/usr/local/lib/node_modules/@remodex/rmx/src/update")).toBe("npm");
  });

  test("does not mistake an ordinary source folder for an npm installation", () => {
    expect(detectInstallAt(join("workspace", "remodex", "src", "update"))).toBe("source");
    expect(detectInstallAt(join("workspace", "node_modules-project", "src", "update"))).toBe("source");
  });

  test("a newer npm package version enables the dashboard Update action", () => {
    const moduleDirectory = String.raw`C:\Users\Example\AppData\Roaming\npm\node_modules\@remodex\rmx\src\update`;
    const result = checkForUpdate("latest", {
      currentVersion: () => "1.1.6",
      detectInstall: () => detectInstallAt(moduleDirectory),
      latestVersion: () => "1.1.7",
      readUpdateJob: () => null,
    });

    expect(result.installer).toBe("npm");
    expect(result.latestVersion).toBe("1.1.7");
    expect(result.updateAvailable).toBe(true);
    expect(result.canUpdate).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.command).not.toContain("desktop");
    expect(PKG).toBe("@remodex/rmx");
    expect(updateCommandStr("npm", "latest", "1.1.7")).toBe(
      "npm install -g @remodex/rmx@1.1.7",
    );
  });
});
