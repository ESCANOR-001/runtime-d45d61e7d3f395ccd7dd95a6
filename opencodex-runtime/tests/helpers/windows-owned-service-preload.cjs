// Child-process fixture for claimOwnedServiceHome. Like its Linux systemctl
// fixture, this describes the test's own installation without consulting or
// changing the developer's real registered service.
if (process.platform === "win32" && typeof Bun !== "undefined") {
  const { spyOn } = require("bun:test");
  // Windows terminates a child immediately for kill(SIGTERM). Deliver the same
  // shutdown event inside this test child so production cleanup can run.
  process.on("message", message => {
    if (message === "owned-service-fixture-shutdown") process.emit("SIGTERM");
  });
  const { join } = require("node:path");
  const probe = require("../../src/service-manager-probe");
  const codexHome = process.env.CODEX_HOME;
  const opencodexHome = process.env.OPENCODEX_HOME;
  if (!codexHome || !opencodexHome) throw new Error("Owned-service fixture requires isolated homes");
  spyOn(probe, "inspectServiceManagerInstallation").mockReturnValue({
    kind: "present",
    claims: [{
      backend: "scheduler",
      definitionPath: join(opencodexHome, "fixture-task.xml"),
      homes: { codexHome, opencodexHome },
      registration: "present",
    }],
  });
}
