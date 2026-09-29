export const packageName = "@remodex/rmx";
export const cliCommand = "rmx";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The Remodex programmatic API requires the Bun runtime. Use `rmx` (aliases: remodex, opencodex, ocx) for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
