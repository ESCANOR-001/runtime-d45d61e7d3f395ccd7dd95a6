import { query as browserQuery } from '@anthropic-ai/claude-agent-sdk/browser';
import type { Query, CanUseTool, OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { claudeInputQueue } from './desktop-sync';
import { claudeRemoteFailure } from './verification';

const API = 'https://api.anthropic.com/v1/code/sessions/';
const configDirectory = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const validBridge = (id: unknown): id is string => typeof id === 'string' && /^cse_[A-Za-z0-9]+$/.test(id);

/** Read only Claude's recorded identity. Never claim its worker or alter its transcript. */
export async function existingBridgeId(nativeId: string, directory = configDirectory()): Promise<string | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId)) return;
  const projects = join(directory, 'projects');
  for (const entry of (await readdir(projects, { withFileTypes: true }).catch(() => [])).slice(0, 4000)) {
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, `${nativeId}.jsonl`);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 16 * 1024 * 1024) continue;
    let found: string | undefined;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line.includes('"bridge-session"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === 'bridge-session' && record.sessionId === nativeId && validBridge(record.bridgeSessionId)) found = record.bridgeSessionId;
      } catch { /* An unfinished final transcript record is not an identity. */ }
    }
    if (found) return found;
  }
}

/** PC-only CLI credentials. Never returned to Android, persisted by Remodex, or logged. */
export async function remoteClientHeaders(directory = configDirectory()): Promise<Record<string, string>> {
  let saved: any;
  try {
    const path = join(directory, '.credentials.json');
    if ((await stat(path)).size > 128 * 1024) throw new Error();
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new Error('Sign in to Claude Code on this PC with claude auth login before connecting existing Desktop chats.'); }
  const auth = saved.claudeAiOauth;
  if (typeof auth?.accessToken !== 'string' || !auth.accessToken || !Array.isArray(auth.scopes) || !auth.scopes.includes('user:sessions:claude_code') || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()) {
    throw new Error('Refresh your Claude Code subscription login on this PC, then reopen this chat.');
  }
  // This connection carries prompts from the paired Android UI. The browser SDK
  // requires its actual host surface; an unsupported value is classified as unknown.
  return { Authorization: `Bearer ${auth.accessToken}`, 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'android',
    ...(typeof saved.trustedDeviceToken === 'string' ? { 'X-Trusted-Device-Token': saved.trustedDeviceToken } : {}) };
}

export type RemoteClientConnection = { query: Query; metadata: Record<string, any>; status?: () => Promise<Record<string, any>> };
export type RemoteClientConnect = (input: {
  bridgeId: string; fromSequenceNum?: number; inbox: ReturnType<typeof claudeInputQueue>; canUseTool: CanUseTool; onElicitation?: OnElicitation;
  abortController: AbortController;
}) => Promise<RemoteClientConnection>;

export const connectRemoteClient: RemoteClientConnect = async input => {
  if (!validBridge(input.bridgeId)) throw new Error('Claude did not record a valid Remote Control link for this chat.');
  const headers = await remoteClientHeaders();
  const url = `${API}${input.bridgeId}`;
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.any([input.abortController.signal, AbortSignal.timeout(12_000)]) });
  if (!response.ok) throw await claudeRemoteFailure(response);
  const metadata = (await response.json() as any).response_shape;
  if (!metadata || metadata.id !== input.bridgeId) throw new Error('Claude returned a different session identity. Connection stopped.');
  if (metadata.connection_status !== 'connected') throw new Error('Open this chat in Claude Desktop and enable /remote-control, then reopen it in Android.');
  return { metadata, status: async () => {
    const response = await fetch(url, { headers: await remoteClientHeaders(), redirect: 'error', signal: AbortSignal.any([input.abortController.signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw await claudeRemoteFailure(response);
    const state = (await response.json() as any).response_shape;
    if (state?.id !== input.bridgeId || state.connection_status !== 'connected') throw new Error('The Desktop worker is offline. Open this chat in Claude Desktop, then reopen it here.');
    return state;
  }, query: browserQuery({ prompt: input.inbox, abortController: input.abortController, canUseTool: input.canUseTool, onElicitation: input.onElicitation,
    sse: { streamUrl: `${url}/events/stream`, sendUrl: `${url}/events`, sessionId: input.bridgeId, fromSequenceNum: input.fromSequenceNum, headers,
      // A missing durable range must never silently leave an incomplete conversation writable.
      onCatchUpTruncated: () => input.abortController.abort(new Error('Claude history changed during reconnect. Reopen this chat to reload it.')),
    } }) };
};
