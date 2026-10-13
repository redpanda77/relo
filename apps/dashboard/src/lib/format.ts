/** "Source › Project › Topic", skipping parts that are missing. */
export function hierarchy(...parts: Array<string | null | undefined>) {
  return parts.filter((part): part is string => Boolean(part?.trim())).join(" › ")
}

export function relativeTime(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  const seconds = (Date.now() - date.valueOf()) / 1000
  if (!Number.isFinite(seconds)) return ""
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  if (Math.abs(seconds) < 60) return "just now"
  if (Math.abs(seconds) < 3600) return format.format(-Math.round(seconds / 60), "minute")
  if (Math.abs(seconds) < 86_400) return format.format(-Math.round(seconds / 3600), "hour")
  if (Math.abs(seconds) < 604_800) return format.format(-Math.round(seconds / 86_400), "day")
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
}
