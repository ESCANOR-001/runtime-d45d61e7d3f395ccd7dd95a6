/** Desktop prepends internal reminders as separate blocks, before the user's
 * text/attachments. Keep literal tags inside a prompt (and string content)
 * intact; never strip arbitrary substrings from something the user typed. */
export function claudeUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let start = 0;
  while (start < content.length - 1) {
    const block = content[start];
    if (block?.type !== 'text' || typeof block.text !== 'string'
      || !/^\s*<system-reminder>(?:(?!<\/?system-reminder>)[\s\S])*<\/system-reminder>\s*$/.test(block.text)) break;
    start++;
  }
  return content.slice(start).filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text).join('\n');
}

/** CLI control output has the user role but does not start an assistant turn. */
export function isClaudeControlMessage(event: Record<string, unknown>, text: string): boolean {
  return event.isSynthetic === true || event.isMeta === true || event.shouldQuery === false
    || /^\s*<local-command-(?:stdout|stderr|caveat)>/.test(text)
    // The SDK history reader can omit isMeta on detached-task notifications.
    // Match its complete control envelope, not tags mentioned inside a prompt.
    || /^\s*<task-notification>\s*<task-id>[^<]+<\/task-id>[\s\S]*<status>(?:completed|failed|stopped|killed)<\/status>[\s\S]*<\/task-notification>(?:\s*Read the output file[^\n]*)?\s*$/.test(text);
}
