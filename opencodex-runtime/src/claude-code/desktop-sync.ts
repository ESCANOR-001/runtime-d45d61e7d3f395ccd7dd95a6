import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** The installed SDK exposes this experimentally at runtime, not in its public types.
 * Keep the compatibility boundary here; never patch the SDK or Desktop to supply it. */
type RemoteQuery = Query & {
  enableRemoteControl?: (enabled: boolean, name?: string, options?: {
    reattachSessionId?: string; keepSessionOnExit: boolean;
  }) => Promise<{ bridge_session_id?: string }>;
};
export async function connectDesktop(query: Query, name: string, previousId?: string): Promise<string> {
  const remote = query as RemoteQuery;
  if (typeof remote.enableRemoteControl !== 'function') {
    throw new Error('This Claude SDK does not support Desktop sync. Update Remodex and retry.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    remote.enableRemoteControl(true, name, {
      ...(previousId ? { reattachSessionId: previousId } : {}), keepSessionOnExit: true,
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        query.close();
        reject(new Error('Claude Desktop sync timed out. The prompt was not sent; check Claude connectivity and retry.'));
      }, 30_000);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!result.bridge_session_id) throw new Error('Claude did not return a shared session identity.');
  if (previousId && result.bridge_session_id !== previousId) {
    await remote.enableRemoteControl(false);
    throw new Error('Claude could not reconnect the original shared session. Sync was disconnected to avoid creating a duplicate.');
  }
  return result.bridge_session_id;
}

/** Cancel only Remodex's unread steers, never another Desktop client's queue. */
export async function interruptClaude(query: Query, offeredUuids: string[]): Promise<string[]> {
  const remote = query as Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> };
  const cancelled: string[] = [];
  if (offeredUuids.length && typeof remote.cancelAsyncMessage !== 'function') {
    throw new Error('Update the Claude SDK before stopping a task with an unread steering message.');
  }
  for (const uuid of offeredUuids) if (await remote.cancelAsyncMessage!(uuid)) cancelled.push(uuid);
  const receipt = await query.interrupt();
  for (const uuid of receipt?.still_queued ?? []) if (offeredUuids.includes(uuid) && !cancelled.includes(uuid)) {
    if (await remote.cancelAsyncMessage!(uuid)) cancelled.push(uuid);
    else throw new Error('Claude has not confirmed cancellation of a steering message. Check the chat before resending it.');
  }
  return cancelled;
}

/** One input stream per owned CLI. Idle means waiting, not ending the session. */
export function claudeInputQueue() {
  const pending: SDKUserMessage[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(message: SDKUserMessage) {
      if (ended) throw new Error('Claude Code disconnected before accepting the prompt.');
      pending.push(message); wake?.();
    },
    cancel(uuid: string) {
      const index = pending.findIndex(message => message.uuid === uuid);
      if (index < 0) return false;
      pending.splice(index, 1); return true;
    },
    close() { ended = true; pending.length = 0; wake?.(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (!ended) {
        const message = pending.shift();
        if (message) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}
