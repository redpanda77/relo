/** A display label: control characters become spaces, trimmed, at most `maximum` characters; undefined when empty. */
export function cleanLabel(value, maximum) {
  const text = Array.from(String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim()).slice(0, maximum).join("").trim();
  return text || undefined;
}
