import { spawn } from "node:child_process";

for (const bytes of [1024 * 1024, 16 * 1024 * 1024 + 32]) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("ready");
    },
    websocket: {
      backpressureLimit: 32 * 1024 * 1024,
      message(socket) {
        const sent = socket.send("x".repeat(bytes));
        console.log(JSON.stringify({ peer: "server", bytes, sent, buffered: socket.getBufferedAmount() }));
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
        socket.addEventListener("open", () => socket.send("probe"));
        socket.addEventListener("message", event => {
          console.log(JSON.stringify({ received: typeof event.data === "string" ? event.data.length : -1, type: typeof event.data }));
          clearTimeout(timer); socket.close(); process.exit(0);
        });
        socket.addEventListener("error", () => console.log(JSON.stringify({ error: true })));
        socket.addEventListener("close", event => console.log(JSON.stringify({ closed: event.code })));
      `, `ws://127.0.0.1:${server.port}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      console.log(JSON.stringify({ peer: executable === "node" ? "node" : "bun", bytes }));
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
