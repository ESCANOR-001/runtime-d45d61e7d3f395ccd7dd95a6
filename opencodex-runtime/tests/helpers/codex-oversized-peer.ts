const oversizedMethod = process.argv[2];
if (!["thread/turns/list", "turn/start"].includes(oversizedMethod ?? "")) {
  throw new Error("Expected an oversized-response test method");
}

let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("ready");
  },
  websocket: {
    backpressureLimit: 32 * 1024 * 1024,
    message(socket, bytes) {
      const message = JSON.parse(String(bytes));
      if (message.id === undefined) return;
      if (message.method === oversizedMethod) {
        requests++;
        const payload = JSON.stringify({ id: message.id, result: "x".repeat(16 * 1024 * 1024) });
        const sent = socket.send(payload);
        if (process.env.REMODEX_TEST_TRANSPORT_DIAGNOSTICS === "1") {
          console.error(JSON.stringify({ method: message.method, bytes: payload.length, sent, buffered: socket.getBufferedAmount() }));
        }
        if (sent === 0) {
          throw new Error("Oversized response was not sent");
        }
      } else {
        socket.send(JSON.stringify({
          id: message.id,
          result: message.method === "initialize" ? { userAgent: "codex/0.153.4" } : { ready: true, requests },
        }));
      }
    },
  },
});

console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => { void server.stop(true).finally(() => process.exit(0)); });
