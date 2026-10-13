// Canonical JSON for server request hashes (idempotency and replay checks). Keys sort with
// localeCompare and undefined values pass through as JSON.stringify writes them. Persisted
// hashes depend on this exact output, so it intentionally differs from the contracts
// package's stricter stableJsonStringify (used for presentation byte budgets).
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
