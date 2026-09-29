import { createHash, randomUUID } from "node:crypto";

/**
 * The Desktop IPC frame is 64 MiB, but history pages intentionally stay far
 * below that ceiling.  A small fixed page leaves room for the envelope,
 * patches, retries, and future protocol fields and makes the bound useful on
 * every transport (including a compressed transport).
 */
export const DESKTOP_HISTORY_PAGE_MAX_TURNS = 10;
export const DESKTOP_HISTORY_PAGE_MAX_ITEMS = 500;
export const DESKTOP_HISTORY_PAGE_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
export const DESKTOP_HISTORY_PAGE_MAX_INLINE_FIELD_BYTES = 256 * 1024;
export const DESKTOP_CONTENT_CHUNK_MAX_BYTES = 1024 * 1024;

const DEFAULT_CONTENT_PREVIEW_BYTES = 8 * 1024;
const DEFAULT_PAGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CONTENT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PAGE_TOKENS = 128;
const DEFAULT_MAX_CONTENT_ENTRIES = 128;
const DEFAULT_MAX_RETAINED_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_COMPACT_COLLECTION_ENTRIES = 1_000;
// Small protocol records (items/turns) should keep their shape when one field
// is large; larger containers are safer as one opaque JSON handle.
const MAX_INLINE_COLLECTION_ENTRIES = 64;
const MAX_COMPACT_METADATA_KEYS = 128;
const MAX_COMPACT_KEY_BYTES = 512;
const MAX_COMPACT_DEPTH = 64;

export type DesktopJsonRecord = Record<string, unknown>;
export type DesktopHistoryPageDirection = "recent" | "older" | "newer";

export type DesktopContentHandleReference = {
  kind: "handle";
  handle: string;
  preview: string;
  byteLength: number;
  mediaType: string;
  truncatedInline: true;
};

export type DesktopMissingContent = {
  kind: "missing";
  reason: "deferred" | "not-retained" | "source-missing";
};

export type DesktopInlineContent = {
  kind: "inline";
  text: string;
  mediaType: string;
};

export type DesktopBoundedContent =
  | DesktopInlineContent
  | DesktopContentHandleReference
  | DesktopMissingContent;

export type DesktopHistoryPageInfo = {
  kind: "desktop-history-page";
  sourceRevision: string;
  order: "oldest-to-newest";
  hasOlder: boolean;
  hasNewer: boolean;
  olderPageToken: string | null;
  newerPageToken: string | null;
  itemsOmitted: number;
  inlineFieldsMovedToHandles: number;
  completeOrExplicitlyPartial: boolean;
};

export type DesktopBoundedHistoryPage = {
  state: DesktopJsonRecord;
  pageInfo: DesktopHistoryPageInfo;
};

export type DesktopContentChunk = {
  kind: "chunk";
  handle: string;
  offset: number;
  nextOffset: number;
  chunkByteLength: number;
  totalByteLength: number;
  mediaType: string;
  encoding: "base64";
  data: string;
  complete: boolean;
} | DesktopMissingContent;

export type DesktopHistoryPageStoreOptions = {
  now?: () => number;
  pageTokenTtlMs?: number;
  contentTtlMs?: number;
  maxPageTokens?: number;
  maxContentEntries?: number;
  maxRetainedContentBytes?: number;
  maxSerializedBytes?: number;
  maxTurns?: number;
  maxItems?: number;
};

type PageTokenState = {
  threadId: string;
  sourceRevision: string;
  direction: Exclude<DesktopHistoryPageDirection, "recent">;
  /** For older pages this is an exclusive end turn index. */
  boundary: number;
  issuedAt: number;
  expiresAt: number;
};

type ContentEntry = {
  threadId: string;
  sourceRevision: string;
  value: Buffer;
  mediaType: string;
  expiresAt: number;
  lastUsedAt: number;
};

type BuildContext = {
  handlesCreated: number;
  itemsOmitted: number;
  itemsIncluded: number;
  seen: WeakSet<object>;
  contentHandles: string[];
  pageTokens: string[];
};

function isRecord(value: unknown): value is DesktopJsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonByteLength(value: unknown, maximumBytes: number): number {
  const estimate = estimateJsonBytes(value, maximumBytes);
  if (estimate === null) return Number.POSITIVE_INFINITY;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : byteLength(encoded);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (byteLength(value) <= maximumBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const next = byteLength(character);
    if (used + next > maximumBytes) break;
    output += character;
    used += next;
  }
  return output;
}

function mediaTypeForKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized.includes("diff") || normalized.includes("patch")) return "text/x-diff";
  if (normalized.includes("output") || normalized.includes("text") || normalized.includes("message")) {
    return "text/plain";
  }
  return "application/json";
}

function opaqueToken(prefix: string): string {
  // UUID bytes are random and the token contains no source cursor, path, or
  // native thread identity.  Keep it URL/JSON friendly for mobile clients.
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function sourceRevision(threadId: string, state: DesktopJsonRecord): string {
  // Hash a bounded sample of each scalar directly into the digest instead of
  // first constructing a second array shaped like the complete transcript.
  // The state can contain hundreds of megabytes of turns; revision tracking
  // must not have a proportional temporary allocation.
  const hash = createHash("sha256");
  const update = (value: unknown): void => {
    hash.update(String(value));
    hash.update("\0");
  };
  const sample = (value: unknown): void => {
    if (typeof value !== "string") {
      update(value ?? "");
      return;
    }
    update(value.length);
    update(value.slice(0, 64));
    update(value.slice(-64));
  };
  update("desktop-history-v1");
  sample(threadId);
  sample(state.updatedAt);
  sample(state.title || state.name);
  const turns = safeArray(state.turns);
  update(turns.length);
  for (const turn of turns) {
    const row = isRecord(turn) ? turn : null;
    sample(row?.id || row?.turnId || row?.turn_id);
    sample(row?.status);
    const items = safeArray(row?.items);
    update(items.length);
    for (const item of items) {
      const candidate = isRecord(item) ? item : null;
      sample(candidate?.id);
      sample(candidate?.type);
      sample(candidate?.status);
      for (const key of ["text", "message"]) sample(candidate?.[key]);
    }
  }
  return `desktop_source_v1_${hash.digest("hex").slice(0, 48)}`;
}

function tokenStateToString(_state: PageTokenState): string {
  // The state itself remains server-side; the client receives only this
  // random key.  In particular, do not base64-encode the native cursor into
  // the token.
  return opaqueToken("desktop_page_v1_");
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A bounded, connection-local history/content store.  Tokens and handles are
 * intentionally opaque and expire; their maps are capped so a client cannot
 * turn pagination into an unbounded memory allocation.
 */
export class DesktopHistoryPageStore {
  private readonly now: () => number;
  private readonly pageTokenTtlMs: number;
  private readonly contentTtlMs: number;
  private readonly maxPageTokens: number;
  private readonly maxContentEntries: number;
  private readonly maxRetainedContentBytes: number;
  private readonly maxSerializedBytes: number;
  private readonly maxTurns: number;
  private readonly maxItems: number;
  private readonly pageTokens = new Map<string, PageTokenState>();
  private readonly content = new Map<string, ContentEntry>();
  private retainedContentBytes = 0;

  constructor(options: DesktopHistoryPageStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pageTokenTtlMs = Math.max(1, options.pageTokenTtlMs ?? DEFAULT_PAGE_TOKEN_TTL_MS);
    this.contentTtlMs = Math.max(1, options.contentTtlMs ?? DEFAULT_CONTENT_TTL_MS);
    this.maxPageTokens = Math.max(1, Math.floor(options.maxPageTokens ?? DEFAULT_MAX_PAGE_TOKENS));
    this.maxContentEntries = Math.max(1, Math.floor(options.maxContentEntries ?? DEFAULT_MAX_CONTENT_ENTRIES));
    this.maxRetainedContentBytes = Math.max(0, Math.floor(options.maxRetainedContentBytes ?? DEFAULT_MAX_RETAINED_CONTENT_BYTES));
    this.maxSerializedBytes = Math.max(1, Math.floor(options.maxSerializedBytes ?? DESKTOP_HISTORY_PAGE_MAX_SERIALIZED_BYTES));
    this.maxTurns = Math.max(1, Math.floor(options.maxTurns ?? DESKTOP_HISTORY_PAGE_MAX_TURNS));
    this.maxItems = Math.max(1, Math.floor(options.maxItems ?? DESKTOP_HISTORY_PAGE_MAX_ITEMS));
  }

  recentPage(threadId: string, state: DesktopJsonRecord): DesktopBoundedHistoryPage {
    const rows = safeArray(state.turns);
    const revision = sourceRevision(threadId, state);
    const start = Math.max(0, rows.length - this.maxTurns);
    return this.buildPage(threadId, state, revision, start, rows.length, "recent");
  }

  page(
    threadId: string,
    state: DesktopJsonRecord,
    direction: Exclude<DesktopHistoryPageDirection, "recent">,
    pageToken: string,
  ): DesktopBoundedHistoryPage {
    this.prune();
    const token = this.pageTokens.get(pageToken);
    if (!token) throw new Error("Desktop history page token is invalid or expired");
    if (token.threadId !== threadId) throw new Error("Desktop history page token belongs to another task");
    const revision = sourceRevision(threadId, state);
    if (token.sourceRevision !== revision) throw new Error("Desktop history source changed; reload the task");
    if (token.direction !== direction) throw new Error("Desktop history page token direction mismatch");
    this.pageTokens.delete(pageToken);
    const rows = safeArray(state.turns);
    if (direction === "older") {
      const end = Math.min(rows.length, Math.max(0, token.boundary));
      const start = this.selectStart(end);
      return this.buildPage(threadId, state, revision, start, end, direction);
    }
    const start = Math.min(rows.length, Math.max(0, token.boundary));
    const end = Math.min(rows.length, start + this.maxTurns);
    return this.buildPage(threadId, state, revision, start, end, direction);
  }

  readContentChunk(input: {
    threadId: string;
    sourceRevision: string;
    handle: string;
    offset: number;
  }): DesktopContentChunk {
    this.prune();
    const entry = this.content.get(input.handle);
    if (!entry) return { kind: "missing", reason: "source-missing" };
    if (entry.threadId !== input.threadId) return { kind: "missing", reason: "source-missing" };
    if (entry.sourceRevision !== input.sourceRevision) return { kind: "missing", reason: "source-missing" };
    const offset = Number.isSafeInteger(input.offset) ? input.offset : -1;
    if (offset < 0 || offset > entry.value.byteLength) return { kind: "missing", reason: "source-missing" };
    entry.lastUsedAt = this.now();
    entry.expiresAt = entry.lastUsedAt + this.contentTtlMs;
    const end = Math.min(entry.value.byteLength, offset + DESKTOP_CONTENT_CHUNK_MAX_BYTES);
    const data = entry.value.subarray(offset, end).toString("base64");
    return {
      kind: "chunk",
      handle: input.handle,
      offset,
      nextOffset: end,
      chunkByteLength: end - offset,
      totalByteLength: entry.value.byteLength,
      mediaType: entry.mediaType,
      encoding: "base64",
      data,
      complete: end >= entry.value.byteLength,
    };
  }

  clearThread(threadId: string): void {
    for (const [token, state] of this.pageTokens) {
      if (state.threadId === threadId) this.pageTokens.delete(token);
    }
    for (const [handle, entry] of this.content) {
      if (entry.threadId !== threadId) continue;
      this.retainedContentBytes -= entry.value.byteLength;
      this.content.delete(handle);
    }
    this.retainedContentBytes = Math.max(0, this.retainedContentBytes);
  }

  get pageTokenCount(): number {
    return this.pageTokens.size;
  }

  get contentEntryCount(): number {
    return this.content.size;
  }

  private selectStart(end: number): number {
    return Math.max(0, Math.max(0, end) - this.maxTurns);
  }

  private newBuildContext(itemsOmitted = 0): BuildContext {
    return {
      handlesCreated: 0,
      itemsOmitted,
      itemsIncluded: 0,
      seen: new WeakSet(),
      contentHandles: [],
      pageTokens: [],
    };
  }

  /** Remove side effects from a candidate that was rejected by the byte guard. */
  private discardBuildContext(context: BuildContext): void {
    for (const handle of context.contentHandles) {
      const entry = this.content.get(handle);
      if (!entry) continue;
      this.retainedContentBytes -= entry.value.byteLength;
      this.content.delete(handle);
    }
    for (const token of context.pageTokens) this.pageTokens.delete(token);
    this.retainedContentBytes = Math.max(0, this.retainedContentBytes);
  }

  private buildPage(
    threadId: string,
    state: DesktopJsonRecord,
    revision: string,
    start: number,
    end: number,
    direction: DesktopHistoryPageDirection,
  ): DesktopBoundedHistoryPage {
    const rows = safeArray(state.turns);
    // Recompute the range against the actual state.  This also avoids relying
    // on any untrusted client-provided index in a token.
    let selectedStart = Math.max(0, Math.min(start, rows.length));
    let selectedEnd = Math.max(selectedStart, Math.min(end, rows.length));
    let selectedRows = rows.slice(selectedStart, selectedEnd);
    let forcedItemsOmitted = 0;
    let context = this.newBuildContext(forcedItemsOmitted);
    let candidate = this.makeState(
      threadId,
      state,
      selectedRows,
      rows.length,
      selectedStart,
      selectedEnd,
      revision,
      context,
      direction,
    );

    while (jsonByteLength(candidate, this.maxSerializedBytes) > this.maxSerializedBytes) {
      this.discardBuildContext(context);
      if (selectedEnd - selectedStart > 1) {
        selectedStart += 1;
        selectedRows = selectedRows.slice(1);
      } else {
        const turnCandidate = selectedRows[0];
        const turn: DesktopJsonRecord | null = isRecord(turnCandidate) ? turnCandidate : null;
        const items = safeArray(turn?.items);
        if (items.length > 1) {
          // Keep the newest work in a single oversized turn and expose the
          // omitted count in pageInfo.  Individual fields are already handles.
          const shortened = { ...turn } as DesktopJsonRecord;
          // Halve the currently selected set, rather than resetting to a
          // fixed max-item count. This guarantees progress even when one
          // turn remains larger than the serialized page budget.
          const nextLength = Math.max(1, Math.floor(items.length / 2));
          shortened.items = items.slice(Math.max(0, items.length - nextLength));
          selectedRows = [shortened];
          forcedItemsOmitted += items.length - nextLength;
        } else {
          context = this.newBuildContext(forcedItemsOmitted);
          candidate = this.minimalState(
            threadId,
            state,
            selectedRows,
            rows.length,
            selectedStart,
            selectedEnd,
            revision,
            context,
            direction,
          );
          break;
        }
      }
      context = this.newBuildContext(forcedItemsOmitted);
      candidate = this.makeState(
        threadId,
        state,
        selectedRows,
        rows.length,
        selectedStart,
        selectedEnd,
        revision,
        context,
        direction,
      );
    }

    // A pathological metadata object can still exceed the page budget after
    // all turns are removed.  The final minimal state is deterministic and
    // always serializable under the same byte guard.
    if (jsonByteLength(candidate, this.maxSerializedBytes) > this.maxSerializedBytes) {
      this.discardBuildContext(context);
      candidate = {
        id: threadId,
        hostId: stringValue(state.hostId) || "local",
        updatedAt: numberValue(state.updatedAt) ?? this.now(),
        turns: [],
        requests: [],
        historyPage: {
          kind: "desktop-history-page",
          sourceRevision: revision,
          order: "oldest-to-newest",
          hasOlder: selectedStart > 0,
          hasNewer: selectedEnd < rows.length,
          olderPageToken: null,
          newerPageToken: null,
          itemsOmitted: forcedItemsOmitted,
          inlineFieldsMovedToHandles: 0,
          completeOrExplicitlyPartial: false,
        },
      } satisfies DesktopJsonRecord;
    }

    const pageInfo = recordPageInfo(candidate.historyPage)!;
    return { state: candidate, pageInfo };
  }

  private makeState(
    threadId: string,
    source: DesktopJsonRecord,
    rows: unknown[],
    totalRows: number,
    start: number,
    end: number,
    revision: string,
    context: BuildContext,
    direction: DesktopHistoryPageDirection,
  ): DesktopJsonRecord {
    const output: DesktopJsonRecord = {};
    const omittedKeys = new Set(["turns", "historyPage"]);
    let metadataKeys = 0;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (omittedKeys.has(key)) continue;
      metadataKeys += 1;
      if (metadataKeys > MAX_COMPACT_METADATA_KEYS) {
        output._desktopHistoryMetadataTruncated = true;
        break;
      }
      if (byteLength(key) > MAX_COMPACT_KEY_BYTES) {
        output._desktopHistoryMetadataTruncated = true;
        continue;
      }
      const value = source[key];
      if (key === "requests") {
        const requestRows = safeArray(value).slice(-64);
        output[key] = requestRows.map(row => this.compactValue(row, threadId, revision, key, context));
        continue;
      }
      output[key] = this.compactValue(value, threadId, revision, key, context);
    }
    output.id = stringValue(source.id) || threadId;
    output.hostId = stringValue(source.hostId) || "local";
    const selectedRows = rows;
    const compactedTurns = new Array<DesktopJsonRecord>(selectedRows.length);
    // Reserve the global item budget from newest to oldest, while retaining
    // the wire order expected by the Desktop renderer.
    for (let index = selectedRows.length - 1; index >= 0; index -= 1) {
      compactedTurns[index] = this.compactTurn(
        selectedRows[index],
        threadId,
        revision,
        context,
        index === selectedRows.length - 1,
      );
    }
    output.turns = compactedTurns;
    const olderToken = start > 0
      ? this.issuePageToken({ threadId, sourceRevision: revision, direction: "older", boundary: start }, context)
      : null;
    const newerToken = end < totalRows
      ? this.issuePageToken({ threadId, sourceRevision: revision, direction: "newer", boundary: end }, context)
      : null;
    output.historyPage = {
      kind: "desktop-history-page",
      sourceRevision: revision,
      order: "oldest-to-newest",
      hasOlder: start > 0,
      hasNewer: end < totalRows,
      olderPageToken: olderToken,
      newerPageToken: newerToken,
      itemsOmitted: context.itemsOmitted,
      inlineFieldsMovedToHandles: context.handlesCreated,
      // A recent page is explicitly partial whenever older turns exist. A
      // page with no adjacent turns is complete even if a field uses a handle.
      completeOrExplicitlyPartial: start === 0 && end === totalRows,
    };
    return output;
  }

  private minimalState(
    threadId: string,
    source: DesktopJsonRecord,
    rows: unknown[],
    totalRows: number,
    start: number,
    end: number,
    revision: string,
    context: BuildContext,
    direction: DesktopHistoryPageDirection,
  ): DesktopJsonRecord {
    const latestCandidate = rows.at(-1);
    const latest: DesktopJsonRecord | null = isRecord(latestCandidate) ? latestCandidate : null;
    const turn = latest
      ? {
          id: stringValue(latest.id || latest.turnId || latest.turn_id),
          turnId: stringValue(latest.turnId || latest.id || latest.turn_id),
          status: this.compactValue(latest.status ?? "completed", threadId, revision, "status", context),
          items: [],
        }
      : null;
    const output: DesktopJsonRecord = {
      id: threadId,
      hostId: stringValue(source.hostId) || "local",
      title: truncateUtf8(stringValue(source.title || source.name), 2048),
      updatedAt: numberValue(source.updatedAt) ?? this.now(),
      turns: turn ? [turn] : [],
      requests: [],
    };
    output.historyPage = {
      kind: "desktop-history-page",
      sourceRevision: revision,
      order: "oldest-to-newest",
      hasOlder: start > 0,
      hasNewer: end < totalRows,
      olderPageToken: start > 0
        ? this.issuePageToken({ threadId, sourceRevision: revision, direction: "older", boundary: start }, context)
        : null,
      newerPageToken: end < totalRows
        ? this.issuePageToken({ threadId, sourceRevision: revision, direction: "newer", boundary: end }, context)
        : null,
      itemsOmitted: context.itemsOmitted + Math.max(0, safeArray(latest?.items).length),
      inlineFieldsMovedToHandles: context.handlesCreated,
      completeOrExplicitlyPartial: false,
    };
    return output;
  }

  private compactTurn(
    value: unknown,
    threadId: string,
    revision: string,
    context: BuildContext,
    newest: boolean,
  ): DesktopJsonRecord {
    if (!isRecord(value)) return { id: "unknown", status: "completed", items: [] };
    const output: DesktopJsonRecord = {};
    let metadataKeys = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (key === "items") continue;
      metadataKeys += 1;
      if (metadataKeys > MAX_COMPACT_METADATA_KEYS) {
        output._desktopHistoryMetadataTruncated = true;
        break;
      }
      if (byteLength(key) > MAX_COMPACT_KEY_BYTES) {
        output._desktopHistoryMetadataTruncated = true;
        continue;
      }
      output[key] = this.compactValue(value[key], threadId, revision, key, context);
    }
    const items = safeArray(value.items);
    const remaining = Math.max(0, this.maxItems - context.itemsIncluded);
    const limit = Math.min(remaining, items.length);
    const selected = limit > 0 ? items.slice(Math.max(0, items.length - limit)) : [];
    if (items.length > selected.length) context.itemsOmitted += items.length - selected.length;
    context.itemsIncluded += selected.length;
    const compactedItems = selected.map(item => this.compactValue(item, threadId, revision, "item", context));
    output.items = compactedItems;
    if (!newest && compactedItems.length === 0) output.items = [];
    return output;
  }

  private compactValue(
    value: unknown,
    threadId: string,
    revision: string,
    key: string,
    context: BuildContext,
    depth = 0,
  ): unknown {
    if (typeof value === "string") {
      // Measure the encoded JSON form as well as UTF-8 bytes. Control-heavy
      // or surrogate-heavy strings can expand substantially when escaped;
      // keeping those inline would make the later page serialization large.
      if (
        byteLength(value) <= DESKTOP_HISTORY_PAGE_MAX_INLINE_FIELD_BYTES
        && estimateJsonBytes(value, DESKTOP_HISTORY_PAGE_MAX_INLINE_FIELD_BYTES) !== null
      ) return value;
      return this.contentReference(threadId, revision, value, mediaTypeForKey(key), context);
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") return String(value);
    if (depth >= MAX_COMPACT_DEPTH) {
      return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
    }
    if (context.seen.has(value)) return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
    context.seen.add(value);
    try {
      // Preflight the complete structure without serializing it. If it is
      // larger than the inline budget, retain it as one opaque value only when
      // its full JSON representation can fit in the bounded content store.
      // This avoids JSON.stringify() on an arbitrarily large array/object.
      const objectValue = value as DesktopJsonRecord;
      const collectionSize = Array.isArray(value)
        ? value.length
        : boundedOwnEntryCount(objectValue, MAX_COMPACT_COLLECTION_ENTRIES + 1);
      if (collectionSize > MAX_INLINE_COLLECTION_ENTRIES) {
        const serialized = this.safeRetainedJson(value);
        if (serialized) {
          return this.contentReference(threadId, revision, serialized, "application/json", context);
        }
        return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
      }
      if (Array.isArray(value)) {
        const output = value.map(entry => this.compactValue(entry, threadId, revision, key, context, depth + 1));
        if (estimateJsonBytes(output, DESKTOP_HISTORY_PAGE_MAX_INLINE_FIELD_BYTES) === null) {
          const serialized = this.safeRetainedJson(value);
          if (serialized) return this.contentReference(threadId, revision, serialized, "application/json", context);
          return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
        }
        return output;
      }
      const output: DesktopJsonRecord = {};
      let keys = 0;
      for (const entryKey in objectValue) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, entryKey)) continue;
        keys += 1;
        if (keys > MAX_COMPACT_COLLECTION_ENTRIES) {
          return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
        }
        const entryValue = objectValue[entryKey];
        if (byteLength(entryKey) > MAX_COMPACT_KEY_BYTES) {
          return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
        }
        output[entryKey] = this.compactValue(entryValue, threadId, revision, entryKey, context, depth + 1);
      }
      if (estimateJsonBytes(output, DESKTOP_HISTORY_PAGE_MAX_INLINE_FIELD_BYTES) === null) {
        const serialized = this.safeRetainedJson(value);
        if (serialized) return this.contentReference(threadId, revision, serialized, "application/json", context);
        return { kind: "missing", reason: "not-retained" } satisfies DesktopMissingContent;
      }
      return output;
    } finally {
      context.seen.delete(value);
    }
  }

  private safeRetainedJson(value: unknown): string | null {
    const available = Math.min(
      this.maxRetainedContentBytes,
      Math.max(0, this.maxRetainedContentBytes - this.retainedContentBytes),
    );
    if (available <= 0) return null;
    const estimate = estimateJsonBytes(value, available);
    if (estimate === null || estimate > available) return null;
    return safeJsonStringWithin(value, available);
  }

  private contentReference(
    threadId: string,
    revision: string,
    value: string,
    mediaType: string,
    context: BuildContext,
  ): DesktopBoundedContent {
    // Reject by byte length before allocating a Buffer. A single field can be
    // larger than the entire retained-content budget (the incident that
    // motivated this store was >170 MiB).
    const length = byteLength(value);
    if (
      length === 0
      || length > this.maxRetainedContentBytes
      || this.retainedContentBytes + length > this.maxRetainedContentBytes
      || context.contentHandles.length >= this.maxContentEntries
    ) {
      return { kind: "missing", reason: "not-retained" };
    }
    const handle = opaqueToken("desktop_content_v1_");
    const bytes = Buffer.from(value, "utf8");
    this.content.set(handle, {
      threadId,
      sourceRevision: revision,
      value: bytes,
      mediaType,
      expiresAt: this.now() + this.contentTtlMs,
      lastUsedAt: this.now(),
    });
    this.retainedContentBytes += bytes.byteLength;
    context.handlesCreated += 1;
    context.contentHandles.push(handle);
    this.prune();
    return {
      kind: "handle",
      handle,
      preview: truncateUtf8(value, DEFAULT_CONTENT_PREVIEW_BYTES),
      byteLength: bytes.byteLength,
      mediaType,
      truncatedInline: true,
    };
  }

  private issuePageToken(
    input: Omit<PageTokenState, "issuedAt" | "expiresAt">,
    context?: BuildContext,
  ): string {
    this.prune();
    const now = this.now();
    const state: PageTokenState = {
      ...input,
      issuedAt: now,
      expiresAt: now + this.pageTokenTtlMs,
    };
    const token = tokenStateToString(state);
    this.pageTokens.set(token, state);
    while (this.pageTokens.size > this.maxPageTokens) {
      const oldest = this.pageTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pageTokens.delete(oldest);
    }
    context?.pageTokens.push(token);
    return token;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, state] of this.pageTokens) {
      if (state.expiresAt <= now) this.pageTokens.delete(token);
    }
    for (const [handle, entry] of this.content) {
      if (entry.expiresAt <= now) {
        this.retainedContentBytes -= entry.value.byteLength;
        this.content.delete(handle);
      }
    }
    this.retainedContentBytes = Math.max(0, this.retainedContentBytes);
    while (this.content.size > this.maxContentEntries) this.evictLeastRecentlyUsedContent();
    while (this.retainedContentBytes > this.maxRetainedContentBytes) this.evictLeastRecentlyUsedContent();
  }

  private evictLeastRecentlyUsedContent(): void {
    let candidate: [string, ContentEntry] | null = null;
    for (const row of this.content) {
      if (!candidate || row[1].lastUsedAt < candidate[1].lastUsedAt) candidate = row;
    }
    if (!candidate) return;
    this.content.delete(candidate[0]);
    this.retainedContentBytes -= candidate[1].value.byteLength;
  }
}

function safeJsonStringWithin(value: unknown, maximumBytes: number): string | null {
  if (maximumBytes <= 0 || (isRecord(value) && typeof value.toJSON === "function")) return null;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || byteLength(encoded) > maximumBytes) return null;
    return encoded;
  } catch {
    return null;
  }
}

function boundedOwnEntryCount(value: DesktopJsonRecord, limit: number): number {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count >= limit) return count;
  }
  return count;
}

/**
 * Estimate JSON bytes without creating a serialized copy. Returning null
 * means the value is cyclic, unsupported, or already beyond the supplied
 * bound. The estimate is deliberately conservative for strings so the later
 * JSON.stringify call can never be asked to build an unbounded value.
 */
function estimateJsonBytes(
  value: unknown,
  maximumBytes: number,
  seen = new WeakSet<object>(),
  depth = 0,
): number | null {
  if (maximumBytes <= 0) return null;
  if (depth >= MAX_COMPACT_DEPTH) return null;
  const stringBytes = (input: string): number | null => {
    let total = 2; // quotes
    for (const character of input) {
      const code = character.codePointAt(0) ?? 0;
      const codeUnit = character.charCodeAt(0);
      total += character === "\b"
        || character === "\f"
        || character === "\n"
        || character === "\r"
        || character === "\t"
        || character === '"'
        || character === "\\"
        ? 2
        : codeUnit >= 0xd800 && codeUnit <= 0xdfff
          ? 6 // JSON.stringify escapes lone UTF-16 surrogates
          : code < 0x20
          ? 6
          : Buffer.byteLength(character, "utf8");
      if (total > maximumBytes) return null;
    }
    return total;
  };
  const add = (left: number, right: number): number | null => {
    const next = left + right;
    return next > maximumBytes ? null : next;
  };

  if (typeof value === "string") return stringBytes(value);
  if (value === null || typeof value === "boolean") return value === null ? 4 : 5;
  if (typeof value === "number") {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && byteLength(encoded) <= maximumBytes
      ? byteLength(encoded)
      : null;
  }
  if (typeof value !== "object") return 4;
  if (seen.has(value)) return null;
  if (isRecord(value) && typeof value.toJSON === "function") return null;
  seen.add(value);
  try {
    let total = 2; // [] or {}
    if (Array.isArray(value)) {
      if (value.length > MAX_COMPACT_COLLECTION_ENTRIES) return null;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) total += 1;
        const entry = estimateJsonBytes(value[index], maximumBytes - total, seen, depth + 1);
        if (entry === null) return null;
        const next = add(total, entry);
        if (next === null) return null;
        total = next;
      }
      return total;
    }
    let index = 0;
    const objectValue = value as DesktopJsonRecord;
    for (const key in objectValue) {
      if (!Object.prototype.hasOwnProperty.call(objectValue, key)) continue;
      if (index >= MAX_COMPACT_COLLECTION_ENTRIES) return null;
      if (index > 0) total += 1;
      const keySize = stringBytes(key);
      if (keySize === null) return null;
      const withKey = add(total, keySize);
      if (withKey === null) return null;
      total = withKey + 1; // colon
      if (total > maximumBytes) return null;
      const entry = estimateJsonBytes(objectValue[key], maximumBytes - total, seen, depth + 1);
      if (entry === null) return null;
      const next = add(total, entry);
      if (next === null) return null;
      total = next;
      index += 1;
    }
    return total;
  } finally {
    seen.delete(value);
  }
}

function recordPageInfo(value: unknown): DesktopHistoryPageInfo | null {
  if (!isRecord(value) || value.kind !== "desktop-history-page") return null;
  return value as unknown as DesktopHistoryPageInfo;
}
