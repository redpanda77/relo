// The numbers Relo promises (plan 10 M6), from contracts through the generated copy, and how they read in prose.
// Help, notes, refusals and the docs builder ({{fact id}}) all format them here, so "5 minutes" is never typed.
import { FACTS, FACT_UNITS } from "./facts.generated.mjs";

export { FACTS, FACT_UNITS };

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** 300 → "5 minutes", 28800 → "8 hours", 604800 → "7 days". */
export function spokenDuration(seconds) {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** 30 → "30s", 600 → "10m", 10800 → "3h", 604800 → "7d". */
export function shortDuration(seconds) {
  if (seconds % 86_400 === 0 && seconds >= 2 * 86_400) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A fact by its dotted id ("question.defaultSeconds"). */
export function factValue(id) {
  const [group, name] = id.split(".");
  const value = FACTS[group]?.[name];
  if (value === undefined || !FACT_UNITS[id]) throw new Error(`Unknown fact: ${id}`);
  return value;
}

/** A fact as it reads in a sentence; `short` for help text ("5m" rather than "5 minutes"). */
export function factText(id, { short = false } = {}) {
  const value = factValue(id);
  switch (FACT_UNITS[id]) {
    case "seconds": return short ? shortDuration(value) : spokenDuration(value);
    case "seconds-list": return value.map(shortDuration).join(", ");
    case "per-minute": return short ? String(value) : `${value} a minute`;
    case "characters": return short ? String(value) : plural(value, "character");
    case "bytes": return value % 1024 === 0 ? `${value / 1024} KB` : plural(value, "byte");
    case "days": return plural(value, "day");
    case "hours": return plural(value, "hour");
    default: return String(value);
  }
}
