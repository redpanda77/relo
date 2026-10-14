// Step names say what happens (ADR 0007): a placeholder or a filler tells the owner nothing on the
// Lock Screen, and "Step N" is what the server shows for a sealed card, so it is never sent as a name.
import { UsageError } from "./errors.mjs";

export const GOOD_STEP_NAMES = '"Run migrations", "Install on iPhone", "Review the diff"';

/** "Step 2", "Phase 1", "todo", "tbd", "misc", "next", a bare number, one word under 3 characters. */
const GENERIC = /^(?:(?:step|phase|stage|task|part|item|section|milestone)\s*#?\s*\d*|todo|to do|tbd|misc|miscellaneous|next|stuff|other|etc|wip|n\/a|none|untitled|placeholder|\.+|-+|\?+)$/iu;

export function isGenericStepName(name) {
  const text = String(name ?? "").trim();
  return GENERIC.test(text) || /^\d+$/u.test(text) || (!/\s/u.test(text) && Array.from(text).length < 3);
}

/** Refuses generic names and names repeated within one card's steps, naming good examples. */
export function checkStepNames(labels) {
  const seen = new Set();
  for (const label of labels) {
    if (isGenericStepName(label)) {
      throw new UsageError(`Step "${label}" says nothing about the work. Name each step for what happens, e.g. ${GOOD_STEP_NAMES}.`, {
        hint: 'relo activity start --title "Deploy 0.7.57" --status "Building" --steps "Build image,Run tests,Ship"',
      });
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      throw new UsageError(`Step "${label}" appears twice. Name each step for what happens, e.g. ${GOOD_STEP_NAMES}.`);
    }
    seen.add(key);
  }
  return labels;
}
