import { claudeVerificationIssue } from './verification';

/** Retry transport loss, never a refusal, identity mismatch, or ownership change. */
export function canRecoverClaudeSync(detail: unknown): boolean {
  const text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  return !claudeVerificationIssue(text) && !/(?:HTTP\s*(?:400|401|403|404|409|410)|denied access|forbidden|policy[_ -]disabled|disabled by.*policy|another.*(?:connection|worker)|taken over|takeover|claimed by another|archived|deleted|different (?:session|working folder)|original shared session|duplicate|history changed|catch.?up.*truncated|does not support Desktop sync|not return a shared session identity)/i.test(text);
}

type Entry = { attempts: number; due: number };
type Outcome = 'connected' | 'defer' | 'cancel';
const delays = [5_000, 15_000, 30_000, 60_000, 120_000];

/** One bounded, serial reconnect lane. It carries IDs only, never prompts or credentials. */
export class ClaudeSyncRecovery {
  private entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private closed = false;
  constructor(private readonly reconnect: (id: string) => Promise<Outcome>) {}

  schedule(id: string, detail?: unknown) {
    if (this.closed) return;
    if (!canRecoverClaudeSync(detail)) { this.cancel(id); return; }
    if (!this.entries.has(id)) this.entries.set(id, { attempts: 0, due: Date.now() + delays[0] });
    this.arm();
  }
  cancel(id: string) { this.entries.delete(id); this.arm(); }
  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.flight || !this.entries.size) return;
    const due = Math.min(...[...this.entries.values()].map(e => e.due));
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, Math.max(1, due - Date.now()));
    this.timer.unref?.();
  }
  /** An explicit clock also makes backoff/concurrency regression checks deterministic. */
  tick(time = Date.now()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    const next = [...this.entries].find(([, e]) => e.due <= time);
    if (!next) { this.arm(); return Promise.resolve(); }
    const [id, entry] = next;
    this.flight = Promise.resolve().then(async () => {
      let outcome: Outcome = 'defer';
      try { outcome = await this.reconnect(id); }
      catch (error) {
        if (!canRecoverClaudeSync(error)) outcome = 'cancel';
        else entry.attempts++;
      }
      // A connected event or explicit stop may have removed/replaced this entry mid-flight.
      if (this.entries.get(id) !== entry) return;
      if (outcome !== 'defer') this.entries.delete(id);
      else entry.due = Date.now() + delays[Math.min(entry.attempts, delays.length - 1)];
    }).finally(() => { this.flight = undefined; this.arm(); });
    return this.flight;
  }
  async close() {
    this.closed = true; this.entries.clear();
    if (this.timer) clearTimeout(this.timer);
    await this.flight;
  }
}
