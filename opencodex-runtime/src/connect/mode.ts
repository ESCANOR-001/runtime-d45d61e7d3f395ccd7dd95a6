export function isConnectRuntime(): boolean {
  return process.env.REMODEX_CONNECT_ONLY === "1";
}

export function defaultProxyPort(): number {
  return 10100;
}

export function connectManagementRouteAllowed(path: string, method: string): boolean {
  if (path === "/api/connect/activity") return method === "GET";
  if (path === "/api/connect/service") return method === "GET" || method === "POST";
  if (path === "/api/update/check") return method === "GET";
  if (path === "/api/diagnostics/desktop-log") return method === "GET";
  if (path === "/api/android-remote" || path.startsWith("/api/android-remote/")) return true;
  if (path === "/api/storage" || path.startsWith("/api/storage/")) return true;
  if (path === "/api/stop") return method === "POST";
  return method === "GET" && path.startsWith("/api/system/");
}
