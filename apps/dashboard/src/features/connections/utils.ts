export function formatConnectionDate(value: string | null): string {
  if (!value) return "Never"
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return "Unknown"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
