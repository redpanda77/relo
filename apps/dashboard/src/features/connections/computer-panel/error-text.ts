/** The text of an error from the service, or a plain fallback. */
export function errorText(cause: unknown, fallback = "Relo could not do that. Check your connection and try again."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

