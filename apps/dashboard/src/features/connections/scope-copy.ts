/** A computer's permissions in plain words (the Access section). Unknown scopes keep their registry name. */
const SCOPE_COPY: Record<string, string> = {
  "notifications:send": "Send notifications",
  "activities:write": "Show and update cards",
  "activities:read": "Read its cards",
  "interactions:create": "Ask you questions",
  "interactions:read": "Read your answers",
  "devices:read": "See your devices' encryption keys",
  "services:read": "Manage its hooks credential and webhooks",
  "services:write": "Manage its hooks credential and webhooks",
}

export function scopeSentences(scopes: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const scope of scopes) seen.add(SCOPE_COPY[scope] ?? scope)
  return [...seen]
}
