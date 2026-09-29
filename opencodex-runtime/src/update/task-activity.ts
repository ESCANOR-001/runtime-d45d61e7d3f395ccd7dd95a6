import type { UpdateActivity } from "./background";

type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

/** Verify activity independently of sidebar subscriptions and their cached rows. */
export function createTaskActivityReader(deps: {
  list: (cursor: string | null) => Promise<unknown>;
  probe: (id: string, row: Row) => Promise<boolean | null>;
  trackedIds: () => Iterable<string>;
  revision: () => number;
  timeoutMs?: number;
}) {
  let pending: Promise<UpdateActivity> | null = null;
  return (): Promise<UpdateActivity> => {
    if (pending) return pending;
    const revision = deps.revision();
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const scan = async (): Promise<UpdateActivity> => {
      let running = 0;
      try {
        const rows = new Map<string, Row>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const result = object(await deps.list(cursor));
          if (expired || !Array.isArray(result?.data)) return { known: false, running };
          for (const value of result.data) {
            const row = object(value);
            if (!row || typeof row.id !== "string" || !row.id || row.id.length > 128) return { known: false, running };
            rows.set(row.id, row);
          }
          if (rows.size > 2000) return { known: false, running };
          if (result.nextCursor == null || result.nextCursor === "") { cursor = null; break; }
          if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) return { known: false, running };
          cursor = result.nextCursor;
          cursors.add(cursor);
        }
        if (cursor !== null) return { known: false, running };
        for (const id of deps.trackedIds()) if (!rows.has(id)) rows.set(id, { id });
        let known = true;
        const work = [...rows];
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(8, work.length) }, async () => {
          while (!expired && index < work.length) {
            const [id, row] = work[index++]!;
            const status = object(row.status)?.type ?? row.status;
            // The private runtime can positively report its own active tasks.
            // notLoaded is not proof that a Desktop-owned task is idle.
            const active = status === "active" || status === "running" || status === "inProgress"
              ? true : await deps.probe(id, row).catch(() => null);
            if (active === true) running++;
            if (active !== true && active !== false) known = false;
          }
        }));
        return { known: !expired && known && deps.revision() === revision, running };
      } catch { return { known: false, running }; }
    };
    const deadline = new Promise<UpdateActivity>(resolve => {
      timer = setTimeout(() => { expired = true; resolve({ known: false, running: 0 }); }, deps.timeoutMs ?? 6000);
    });
    const work = scan();
    const result = Promise.race([work, deadline]);
    pending = result;
    // Keep a timed-out scan coalesced until its current I/O settles. Repeated
    // phone polls must not accumulate unbounded owner requests during an outage.
    void work.finally(() => { clearTimeout(timer); if (pending === result) pending = null; });
    return result;
  };
}
