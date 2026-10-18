import type { StagedAndroidAttachments } from '../android-remote/attachments';

type Row = Record<string, any>;

/** Keep unsent prompts on the PC, rather than handing Claude an uneditable queue. */
export type ClaudeQueuedPrompt = {
  id: string;
  command: Row;
  clientId: string;
  staged: StagedAndroidAttachments | null;
  createdAt: string;
  updatedAt: string;
  attempted?: boolean;
  uncertain?: boolean;
};

/** UUIDs distinguish an offered steer from one Claude actually started reading. */
export type ClaudePromptDelivery = {
  uuid: string;
  messageId: string;
  turnId: string;
  state: 'offered' | 'consumed' | 'cancelled';
  steer?: ClaudeQueuedPrompt;
};

export function claudeQueuedMessages(queue: ClaudeQueuedPrompt[]): Row[] {
  return queue.map((entry, queuePosition) => ({
    id: entry.id, role: 'user', text: entry.command.queueDisplayText ?? entry.command.message.text,
    attachments: [], turnId: null, phase: 'queued', queuePosition, streaming: false,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt,
  }));
}

export function validateClaudeFollowUp(message: Row, queueLength: number): void {
  if (queueLength >= 32) throw new TypeError('This chat has 32 queued messages. Remove one before adding more.');
  if (typeof message.text !== 'string' || message.text.length > 120_000) throw new TypeError('The follow-up prompt is too long.');
  if (!message.text.trim() && !message.attachments?.length) throw new TypeError('Enter a prompt or add an attachment.');
  const id = message.messageId ?? message.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:/-]{1,256}$/.test(id)) throw new TypeError('A valid message ID is required.');
}

export function consumedClaudePromptIds(event: Row): string[] {
  const ids = Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [];
  return [...new Set([
    ...ids.filter((id: unknown): id is string => typeof id === 'string'),
    ...(typeof event.user_message_uuid === 'string' ? [event.user_message_uuid] : []),
    ...(event.type === 'command_lifecycle' && event.state === 'started' && typeof event.command_uuid === 'string'
      ? [event.command_uuid] : []),
  ])];
}
