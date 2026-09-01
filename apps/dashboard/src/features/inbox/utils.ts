export function formatDashboardDate(value: string | null): string {
  if (!value) return "Not recorded"
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "Not recorded"
}
