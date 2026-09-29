export type AttachmentUserMessageIdentity = {
  readonly text: string;
  readonly attachmentCount: number;
};

const CODEX_FILES_MENTIONED_HEADER = /^#\s+Files mentioned by the user:\s*$/imu;
const CODEX_REQUEST_HEADER = /^##\s+My request(?:\s+for\s+Codex)?:\s*$/imu;
const CODEX_LEADING_REQUEST_HEADER = /^##\s+My request(?:\s+for\s+Codex)?:\s*(?:\n+|$)/iu;

/**
 * Codex Desktop can persist the bootstrap envelope as a user-looking message
 * on some transports (most noticeably the Windows Desktop route). These are
 * protocol blocks, not conversation content. Keep this list explicit: a
 * loose "strip every XML-looking thing" rule would destroy prompts that are
 * legitimately discussing markup.
 */
const PRIVATE_BOOTSTRAP_BLOCK_NAMES = [
  "recommended_plugins",
  "environment_context",
  "app-context",
  "in-app-browser-context",
  "response-annotations",
  "skills_instructions",
  "permissions instructions",
  "apps_instructions",
  "plugins_instructions",
  "model_switch",
  "multi_agent_mode",
  "collaboration_mode",
  // Older Desktop/app-server builds use this generic wrapper for injected
  // instructions. Keep the legacy behavior while applying the same bounded
  // parser as the newer named blocks.
  "INSTRUCTIONS",
] as const;

const PRIVATE_SYNTHETIC_BLOCK_NAMES = [
  "codex_delegation",
  "subagent_notification",
] as const;

const PRIVATE_CONTROL_BLOCK_NAMES = ["turn_aborted"] as const;

const PRIVATE_BLOCK_NAMES = [
  ...PRIVATE_BOOTSTRAP_BLOCK_NAMES,
  ...PRIVATE_SYNTHETIC_BLOCK_NAMES,
  ...PRIVATE_CONTROL_BLOCK_NAMES,
].sort((left, right) => right.length - left.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const PRIVATE_BLOCK_NAME_PATTERN = PRIVATE_BLOCK_NAMES.map(escapeRegExp).join("|");
const PRIVATE_BLOCK_OPEN = new RegExp(
  `^\\s*<(${PRIVATE_BLOCK_NAME_PATTERN})(?:\\s[^<>]*?)?\\s*(/?)>`,
  "iu",
);

// Desktop prefixes repository instructions with a Markdown heading on Windows
// and POSIX hosts. Require the generated heading and its instruction wrapper;
// a user discussing AGENTS.md is still ordinary conversation text.
const AGENTS_INSTRUCTIONS_HEADING = /^\s*# AGENTS\.md instructions for [^\n]+\n\s*(?=<INSTRUCTIONS(?:\s|>))/iu;

type ParsedPrivateBlock = {
  readonly name: string;
  readonly end: number;
};

/**
 * Find the matching close for one recognized block. A small balanced scanner
 * handles the duplicated nested <collaboration_mode> wrappers emitted by a
 * few Desktop versions without interpreting unrelated tags as private.
 */
function parsePrivateBlock(value: string, offset: number): ParsedPrivateBlock | null {
  const opening = PRIVATE_BLOCK_OPEN.exec(value.slice(offset));
  if (!opening) return null;
  const name = opening[1];
  if (!name) return null;
  const openingEnd = offset + opening[0].length;
  if (opening[2] === "/") return { name, end: openingEnd };

  const tagPattern = new RegExp(
    `<\\/?${escapeRegExp(name)}(?:\\s[^<>]*?)?\\s*(/?)>`,
    "giu",
  );
  tagPattern.lastIndex = openingEnd;
  let depth = 1;
  for (;;) {
    const next = tagPattern.exec(value);
    if (!next) return null;
    const token = next[0];
    if (/^<\//u.test(token)) {
      depth -= 1;
      if (depth === 0) return { name, end: next.index + token.length };
    } else if (next[1] !== "/") {
      depth += 1;
    }
  }
}

/**
 * Remove a complete sequence of recognized private protocol blocks at the
 * beginning of a value. Report a recognized but incomplete opening so the
 * public boundary can fail closed instead of exposing a partially patched or
 * truncated bootstrap record.
 */
function stripLeadingPrivateBlocks(value: string): {
  text: string;
  stripped: boolean;
  incomplete: boolean;
} {
  let cursor = 0;
  let stripped = false;
  for (;;) {
    const heading = AGENTS_INSTRUCTIONS_HEADING.exec(value.slice(cursor));
    if (heading) {
      cursor += heading[0].length;
      stripped = true;
    }
    const parsed = parsePrivateBlock(value, cursor);
    if (!parsed || !PRIVATE_BLOCK_NAMES.some(name => name.toLowerCase() === parsed.name.toLowerCase())) {
      const remainder = value.slice(cursor);
      return {
        text: stripped ? remainder.replace(/^\s+/u, "") : value,
        stripped,
        incomplete: PRIVATE_BLOCK_OPEN.test(remainder),
      };
    }
    cursor = parsed.end;
    stripped = true;
  }
}

function unwrapCodexAttachmentEnvelope(value: string): string {
  const filesHeader = CODEX_FILES_MENTIONED_HEADER.exec(value);
  if (!filesHeader || value.slice(0, filesHeader.index).trim()) return value;
  const remainderOffset = filesHeader.index + filesHeader[0].length;
  const remainder = value.slice(remainderOffset);
  const requestHeader = CODEX_REQUEST_HEADER.exec(remainder);
  if (!requestHeader) return value;
  const privateEnvelope = remainder.slice(0, requestHeader.index);
  // A real generated envelope contains at least one secondary Markdown
  // heading with an absolute attachment path. This keeps the unwrap narrow.
  if (!/^##\s+[^\n:]+:\s+(?:\/|[A-Za-z]:[\\/]|\\\\)/mu.test(privateEnvelope)) {
    return value;
  }
  return remainder
    .slice(requestHeader.index + requestHeader[0].length)
    .replace(/^\n+/u, "");
}

/**
 * Return the text that is safe to expose in the Android transcript.
 *
 * `null` means the source is a recognized synthetic/control record with no
 * public conversation content. Ordinary text—including text that merely
 * mentions one of the protocol tag names—passes through unchanged.
 */
export function sanitizePublicTranscriptText(value: unknown): string | null {
  if (typeof value !== "string") return "";
  const normalized = value.includes("\r\n") ? value.replaceAll("\r\n", "\n") : value;
  const stripped = stripLeadingPrivateBlocks(normalized);
  // Live Desktop patches can expose a text field before its closing protocol
  // tag arrives. Once the opening tag identifies the field as private, keep it
  // hidden until a complete block lets us safely separate any following user
  // prompt. This also fails closed for a truncated persisted record.
  if (stripped.incomplete) return null;
  const candidate = stripped.stripped
    ? stripped.text.replace(CODEX_LEADING_REQUEST_HEADER, "")
    : stripped.text;

  if (stripped.stripped && !candidate.trim()) return null;
  return unwrapCodexAttachmentEnvelope(candidate);
}

/** Roles that are model context rather than public conversation participants. */
export function isPrivateTranscriptRole(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return normalized === "developer" || normalized === "system" || normalized === "tool";
}

/**
 * Codex Desktop stores attachment prompts with a private transport envelope:
 * a list of local paths followed by a "My request" section. The Desktop UI
 * hides that envelope, so Android must expose only the request as well.
 *
 * Match the complete, generated heading pair instead of a loose substring so
 * an ordinary prompt that merely discusses these words remains untouched.
 */
export function publicUserMessageText(value: unknown): string {
  return sanitizePublicTranscriptText(value) ?? "";
}

/** Canonical visible prompt text used only to reconcile transport echoes. */
export function canonicalUserMessageText(value: unknown): string {
  let normalized = publicUserMessageText(value);
  normalized = normalized.replace(/<image\b[^>]*>/giu, "");
  normalized = normalized.replace(/<\/image>/giu, "");
  normalized = normalized.replace(/\[Image:\s*[^\]\n]+\]/giu, "");
  normalized = normalized.replace(/\[File attached:\s*[^\]\n]+\]/giu, "");
  normalized = normalized.replace(
    /(^|\n)Files uploaded from Android and staged on this PC:\n(?:[ \t]*-[^\n]*(?:\n|$))+/giu,
    "$1",
  );
  return normalized.replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * Codex Desktop and app-server serialize the same attachment differently.
 * Reduce only messages that actually contain attachment markers to a stable
 * identity; ordinary user text remains byte-for-byte significant.
 */
export function attachmentUserMessageIdentity(
  value: unknown,
): AttachmentUserMessageIdentity | null {
  if (typeof value !== "string") return null;
  let attachmentCount = 0;
  let normalized = publicUserMessageText(value);
  normalized = normalized.replace(/<image\b[^>]*>/giu, () => {
    attachmentCount += 1;
    return "";
  });
  normalized = normalized.replace(/<\/image>/giu, "");
  normalized = normalized.replace(/\[Image:\s*[^\]\n]+\]/giu, () => {
    attachmentCount += 1;
    return "";
  });
  normalized = normalized.replace(/\[File attached:\s*[^\]\n]+\]/giu, () => {
    attachmentCount += 1;
    return "";
  });
  normalized = normalized.replace(
    /(^|\n)Files uploaded from Android and staged on this PC:\n((?:[ \t]*-[^\n]*(?:\n|$))+)/giu,
    (_match, prefix: string, paths: string) => {
      attachmentCount += paths.split("\n").filter(line => /^\s*-/u.test(line)).length;
      return prefix;
    },
  );
  if (attachmentCount === 0) return null;
  return {
    text: normalized.replace(/\n{3,}/gu, "\n\n").trim(),
    attachmentCount,
  };
}

export function attachmentUserMessageIdentityKey(value: unknown): string | null {
  const identity = attachmentUserMessageIdentity(value);
  return identity === null
    ? null
    : `${identity.attachmentCount}\u0000${identity.text}`;
}
