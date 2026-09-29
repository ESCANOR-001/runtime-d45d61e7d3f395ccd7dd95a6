/**
 * Normalize legacy examples supplied by older runtime payloads without
 * rewriting compatibility identifiers such as `ocx_` tokens or provider IDs.
 */
export function canonicalizeRemodexCliExample(value: string): string {
  return value
    .replace(/(^|(?:&&|\|\||;)\s*)ocx(?=\s|$)/gm, "$1rmx")
    .replace(/(^|[\\/])\.opencodex(?=([\\/]|$))/g, "$1.remodex");
}
