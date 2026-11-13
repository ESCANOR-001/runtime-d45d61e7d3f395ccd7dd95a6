// Report process startup before loading the real server's module graph. This
// distinguishes a cold runner/import delay from a failed ownership handover.
process.stdout.write(`@@native-owner@@${JSON.stringify({ event: "booting", at: Date.now() })}\n`);
await import("./native-main-owner-child.ts");
export {};
