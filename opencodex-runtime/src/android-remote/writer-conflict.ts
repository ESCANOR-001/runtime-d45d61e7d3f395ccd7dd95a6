/** A writer rejection happens before Codex accepts the new turn. */
export function codexHasActiveWriter(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\balready has an active writer\b/iu.test(message);
}

/** Only used after a definite rejection, never after uncertain delivery. */
export class WriterOwnershipUnavailableError extends Error {
  constructor() {
    super("This task is reconnecting to Codex. Your message is saved and waiting to send.");
    this.name = "WriterOwnershipUnavailableError";
  }
}
