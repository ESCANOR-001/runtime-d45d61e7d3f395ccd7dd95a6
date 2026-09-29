import { isConnectRuntime } from "../../connect/mode";
import { assertServiceEnvironmentMatchesInstall, diagnoseService } from "../../service";
import { serviceSetupState, startServiceSetup } from "../../connect/service-setup";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

export async function handleConnectServiceRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, deps, principal } = ctx;
  if (!isConnectRuntime() || url.pathname !== "/api/connect/service") return null;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.method === "POST") {
    if (principal !== "gui-session") return json({ error: "Confirm this action in the local dashboard." }, 403);
    if (process.env.OCX_SERVICE === "1") return json({ error: "Run rmx service repair in a terminal to repair a running service." }, 409);
    let body: { action?: unknown; confirm?: unknown };
    try { body = await readManagementJsonBody(req); }
    catch (error) { rethrowManagementBodyTooLarge(error); return json({ error: "Invalid confirmation" }, 400); }
    if (!body || body.confirm !== true || !["install", "repair"].includes(String(body.action))
      || Object.keys(body).some(key => key !== "action" && key !== "confirm")) return json({ error: "Explicit service confirmation required" }, 400);
    try {
      (deps.assertConnectServiceOwnership ?? assertServiceEnvironmentMatchesInstall)();
      const service = (deps.connectServiceDiagnostic ?? diagnoseService)();
      if (!service.supported || service.conflict) return json({ error: "Service setup is unavailable or conflicting." }, 409);
      if ((body.action === "repair") !== service.installed) return json({ error: "Service status changed. Refresh before continuing." }, 409);
      if (!["idle", "failed"].includes((deps.connectServiceSetupState ?? serviceSetupState)())) return json({ error: "Another service action is pending. Refresh its status before retrying." }, 409);
      await (deps.startConnectServiceSetup ?? startServiceSetup)(body.action as "install" | "repair");
      return json({ ok: true }, 202);
    } catch {
      return json({ error: "Service setup could not be confirmed. Refresh status before retrying; use rmx service status for details." }, 503);
    }
  }
  try {
    let owned = true;
    try { (deps.assertConnectServiceOwnership ?? assertServiceEnvironmentMatchesInstall)(); } catch { owned = false; }
    const service = (deps.connectServiceDiagnostic ?? diagnoseService)();
    return json({
      platform: process.platform,
      supported: service.supported,
      installed: service.installed,
      healthy: service.installed && service.viable && !service.stale && !service.conflict,
      canManage: owned && service.supported && !service.conflict && process.env.OCX_SERVICE !== "1",
      operation: (deps.connectServiceSetupState ?? serviceSetupState)(),
    });
  } catch { return json({ error: "Service status is unavailable. No settings were changed." }, 503); }
}
