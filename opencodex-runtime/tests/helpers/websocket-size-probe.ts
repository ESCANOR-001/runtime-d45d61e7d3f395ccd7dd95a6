import { spawn } from "node:child_process";

for (const bytes of [1024 * 1024, 16 * 1024 * 1024 + 32]) {
 for (const mode of ["plain", "json", "after-initialize"]) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("ready");
    },
    websocket: {
      backpressureLimit: 32 * 1024 * 1024,
      message(socket, request) {
        if (String(request) === "initialize") {
          socket.send(JSON.stringify({ id: 1, result: { userAgent: "codex/0.153.4" } }));
          return;
        }
        const payload = mode === "plain" ? "x".repeat(bytes) : JSON.stringify({ id: 2, result: "x".repeat(bytes) });
        const sent = socket.send(payload);
        console.log(JSON.stringify({ peer: "server", mode, bytes, sent, buffered: socket.getBufferedAmount() }));
      },
      drain(socket) {
        console.log(JSON.stringify({ peer: "server", bytes, drained: true, buffered: socket.getBufferedAmount() }));
      },
    },
  });
  try {
    for (const executable of [process.execPath, "node"]) {
      const child = spawn(executable, ["--input-type=module", "-e", `
        const socket = new WebSocket(process.argv[1]);
        const timer = setTimeout(() => { console.log(JSON.stringify({ timeout: true })); process.exit(2); }, 8000);
        let initialized = ${mode !== "after-initialize"};
        socket.addEventListener("open", () => socket.send(initialized ? "probe" : "initialize"));
        socket.addEventListener("message", event => {
          console.log(JSON.stringify({ received: typeof event.data === "string" ? event.data.length : -1, type: typeof event.data }));
          if (!initialized) { initialized = true; socket.send("probe"); return; }
          clearTimeout(timer); socket.close(); process.exit(0);
        });
        socket.addEventListener("error", () => console.log(JSON.stringify({ error: true })));
        socket.addEventListener("close", event => console.log(JSON.stringify({ closed: event.code })));
      `, `ws://127.0.0.1:${server.port}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      console.log(JSON.stringify({ peer: executable === "node" ? "node" : "bun", mode, bytes }));
      child.stdout.on("data", data => process.stdout.write(data));
      child.stderr.on("data", data => process.stderr.write(data));
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    }
  } finally {
    await server.stop(true);
  }
 }
}
