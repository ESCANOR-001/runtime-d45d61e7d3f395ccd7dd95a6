export type ClaudeVerificationIssue = 'device-verification' | 'sign-in';

/** Classify only reported connection failures, never account preferences or transcript text. */
export function claudeVerificationIssue(error: unknown): ClaudeVerificationIssue | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/trusted[_ -]device(?:s)?[_ -](?:required|not[_ -]enrolled|session[_ -]expired)|(?:requires? trusted devices|device is not enrolled|session expired for trusted.device check|device verification required|trusted.device verification required)/i.test(message)) return 'device-verification';
  if (/(?:sign in to Claude Code|refresh your Claude Code.*login|refresh your Claude Code subscription login|authentication_required|authentication_error|invalid authentication credentials|unauthenticated|Remote Control requires a full.scope login token)/i.test(message)) return 'sign-in';
  return null;
}

export const claudeVerificationMessage = (issue: ClaudeVerificationIssue) => issue === 'device-verification'
  ? 'Claude device verification required. Complete the sign-in or trusted-device prompt in Claude on this PC, then retry this chat. Your Remodex PC pairing is still saved.'
  : 'Sign in to Claude Code on this PC with claude auth login, then retry this chat. Your Remodex PC pairing is still saved.';

/** Return fixed safe copy, not upstream bodies, URLs, account data or credentials. */
export async function claudeRemoteFailure(response: Response): Promise<Error> {
  let detail = '';
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      while (size <= 16_384) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > 16_384) break;
        chunks.push(item.value);
      }
      if (size <= 16_384) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder().decode(bytes));
        detail = [body?.error?.type, body?.error?.code, body?.error?.message, body?.code, body?.message]
          .filter(v => typeof v === 'string').map(v => v.slice(0, 1000)).join(' ');
      }
    } catch { /* Unknown bodies retain the ordinary connection error. */ }
    finally { await reader.cancel().catch(() => {}); }
  }
  const issue = claudeVerificationIssue(detail);
  if (issue) return new Error(claudeVerificationMessage(issue));
  if (response.status === 401) return new Error(claudeVerificationMessage('sign-in'));
  return new Error(response.status === 403
    ? 'Claude denied access to this shared chat (HTTP 403). Check Remote Control and the signed-in account in Claude Desktop. Device verification could not be confirmed.'
    : `Claude Remote Control is unavailable (HTTP ${response.status}). Reopen the chat to retry.`);
}
