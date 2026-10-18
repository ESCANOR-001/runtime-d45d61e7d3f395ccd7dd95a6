import { nativeHistoryIsUnsupported } from "./native-turn-history";
type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

/** An interrupt acknowledgement is not a terminal event. Read only from the owning engine. */
export async function confirmNativeTurnStopped(options: {
  threadId: string;
  turnId: string;
  read: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<"completed" | "interrupted" | "failed"> {
  if (options.turnId.startsWith("opencodex-pending-")) throw new Error("The task is still starting; its native turn has not been confirmed yet.");
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  do {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        options.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Task status read timed out")), Math.max(1, deadline - Date.now())); }),
      ]);
      const thread = row(row(response)?.thread) ?? row(response);
      if (thread?.id === options.threadId && Array.isArray(thread.turns)) {
        const turn = thread.turns.map(row).find(turn => turn?.id === options.turnId);
        const status = turn?.status;
        if (status === "completed" || status === "interrupted" || status === "failed") return status;
      }
    } catch { /* A failed read is unknown, never proof of completion. */ }
    finally { if (timer) clearTimeout(timer); }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error("Stop was requested, but the task has not confirmed it finished. Refresh and try Stop again.");
}

/** Prefer a bounded status-only page; legacy engines may require thread/read. */
export async function readNativeStopState(threadId: string, request: (method: string, params: Row) => Promise<unknown>): Promise<unknown> {
  try {
    const result = row(await request("thread/turns/list", { threadId, limit: 10, sortDirection: "desc", itemsView: "summary" }));
    if (Array.isArray(result?.data)) return { id: threadId, turns: result.data };
    // Older engines and compatibility clients may return no page shape.
  } catch (error) { if (!nativeHistoryIsUnsupported(error)) throw error; }
  return request("thread/read", { threadId, includeTurns: true });
}

/** Manual Stop must also prevent an active goal from scheduling another turn. */
export async function pauseNativeGoal(threadId: string, request: (method: string, params: Row) => Promise<unknown>): Promise<void> {
  let response: Row | null;
  try { response = row(await request("thread/goal/get", { threadId })); }
  catch (error) { if (nativeHistoryIsUnsupported(error)) return; throw error; }
  if (row(response?.goal)?.status !== "active") return;
  const paused = row(await request("thread/goal/set", { threadId, status: "paused", origin: "user" }));
  if (row(paused?.goal)?.status !== "paused") throw new Error("The turn stopped, but Codex did not confirm the goal was paused.");
}

/** Native turn/start error responses precede accepted submission; a lost response does not. */
export function nativeStartDefinitelyRejected(error: unknown): boolean {
  const code = row(error)?.code;
  return (row(error)?.codexRequestRejected === true && row(error)?.requestMethod === "turn/start")
    || code === -32600 || code === -32601 || code === -32602;
}
