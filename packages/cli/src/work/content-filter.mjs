// Content filter (plan 2.6): card text is real words, one line, short, and never a path or a secret.
// One primitive for every producer type; it runs before any request and in --dry-run.
// A refusal names the rule so the agent rewrites once, and never echoes a matched secret.
import { UsageError } from "../shared/errors.mjs";
import { FACTS } from "../shared/facts.generated.mjs";

const LIMITS = {
  goal: FACTS.work.goalMax, label: FACTS.work.stepLabelMax, status: FACTS.work.statusMax,
  outcome: FACTS.work.outcomeMax, waiting: FACTS.work.waitingMax, detail: 240, stepDetail: FACTS.work.detailMax,
  // What Relo for Mac says aloud (ADR 0015): the gist and the spoken name; spoken.mjs adds the rules for the ear.
  spoken: 160, name: 32,
};

const EXAMPLES = '"Run migrations", "Review the diff"';

/** F-4: whole text (case-insensitive, trailing .!: stripped) that says nothing to the owner. */
const PLACEHOLDER = new RegExp("^(?:(?:step|phase|stage|part|task|item|section|milestone)\\s*#?\\s*\\d+(?:\\s*(?:of|/)\\s*\\d+)?"
  + "|todo|to do|tbd|tba|…|\\.{2,}|-+|\\?+|next|done|finished|complete|completed|continuing|starting|started|working"
  + "|working on it|in progress|wip|misc|miscellaneous|stuff|things|other|etc|placeholder|untitled|n/a|none|ok|update|updating"
  + "|status|progress|running|pending|tasks?|steps?|work|foo|bar|lorem ipsum)$", "iu");

/** F-7: an absolute file path (a URL is not one). */
const PATH = /(^|[\s"'(=])(?:\/(?:Users|home|private|var|tmp|etc|opt|usr|Volumes|root|mnt|srv|Library)\/\S*|~\/\S+|[A-Za-z]:\\\S+|file:\/\/\S+)/u;

/** F-8: known secret prefixes, or a long mixed-case alphanumeric run (lower-case hex such as a git SHA passes). */
const TOKEN_PREFIXES = [
  /sk-[A-Za-z0-9_-]{16,}/u, /\bsk_live_/u, /\brk_live_/u, /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]/u, /\bgithub_pat_/u,
  /\bxox[abprs]-/u, /\bAKIA[0-9A-Z]{16}\b/u, /\bAIza[0-9A-Za-z_-]{30,}/u, /\beyJ[\w-]{10,}\.[\w-]{10,}\./u,
  /-----BEGIN [A-Z ]*PRIVATE KEY/u, /\brelo_(?:live|cli|pat|tok)_[A-Za-z0-9]/u, /\bhook_[A-Za-z0-9_-]{16,}/u,
];
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/gu;

export function looksLikeToken(text) {
  if (TOKEN_PREFIXES.some((pattern) => pattern.test(text))) return true;
  for (const run of text.match(LONG_RUN) ?? []) {
    if (/[A-Z]/u.test(run) && /[a-z]/u.test(run) && /\d/u.test(run)) return true;
  }
  return false;
}

export const hasAbsolutePath = (text) => PATH.test(text);

function refuse(message, flag) {
  return Object.assign(new UsageError(`Refused: ${message}`, { hint: `Next: run it again with ${flag} "…"` }), { code: "CONTENT_REFUSED" });
}

const isPlaceholder = (text) => PLACEHOLDER.test(text.replace(/[.!:]+$/u, "").trim());
/** F-5: one word under 3 characters, or digits only. */
const tooShort = (text) => /^\d+$/u.test(text) || (!/\s/u.test(text) && Array.from(text).length < 3);
/** Real words: at least one run of two letters. */
const hasWords = (text) => /\p{L}{2,}/u.test(text);

/**
 * Checks one card text. `field` picks the limit (LIMITS key); `flag` names it in the refusal ("--status",
 * "step"). `{ words: false }` applies only the one-line, length, path and token rules (detail, questions).
 * Returns the normalized text or throws a UsageError (code CONTENT_REFUSED, exit 2).
 */
export function checkText(field, value, { flag = `--${field}`, goal, words = true } = {}) {
  if (typeof value !== "string") throw refuse(`${flag} is empty.`, flag);
  if (/[\r\n]/u.test(value)) throw refuse(`${flag} is two lines; card text is one line.`, flag);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) throw refuse(`${flag} contains control characters.`, flag);
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!text) throw refuse(`${flag} is empty.`, flag);
  const limit = LIMITS[field] ?? LIMITS.label;
  const length = Array.from(text).length;
  if (length > limit) throw refuse(`${flag} is ${length} characters; the limit is ${limit}. Say it shorter; the card shows about 40.`, flag);
  if (words && (isPlaceholder(text) || !hasWords(text) || (field === "label" && tooShort(text)))) {
    throw refuse(`${flag} "${text}" says nothing to the owner (a placeholder). Name what happens, e.g. ${EXAMPLES}.`, flag);
  }
  if (field === "status" && goal && text.toLowerCase() === String(goal).trim().toLowerCase()) {
    throw refuse("--status repeats the goal; say what is happening now.", flag);
  }
  if (hasAbsolutePath(text)) {
    throw refuse(`${flag} contains a file path; the owner's screen never shows paths. Name the thing instead ("the release script").`, flag);
  }
  if (looksLikeToken(text)) throw refuse(`${flag} contains something that looks like a secret or token; it was not sent.`, flag);
  return text;
}

/**
 * F-9 (DOGFOOD #19): a step the owner performs. A plan is the agent's own work; what the owner must do is
 * a question (`relo ask`) or a note, never a step that makes the card wait on a person.
 */
const OWNER_ACTOR = new RegExp([
  String.raw`^(?:the\s+)?(?:owner|you)(?:'s)?\b`,
  String.raw`^(?:the\s+)?user\s+(?:installs?|verif(?:y|ies)|tests?|approves?|confirms?|reviews?|checks?|tries|try|signs?|opens?|runs?|decides?|merges?|deploys?|restarts?|accepts?|clicks?|taps?)\b`,
  // A step that is itself the wait ("Wait for approval", "then wait on you"); "waiting on you" named as a
  // state inside a step ("Fix the false waiting on you") is the agent's own work.
  String.raw`(?:^|\b(?:and|then)\s+)wait(?:s|ing)? (?:for|on) (?:the )?(?:owner|user|you|your|approval|sign-?off|review by)\b`,
  String.raw`\b(?:ask|ping|tell|remind) (?:the )?(?:owner|user)\b`,
  String.raw`\b(?:verify|verifies|test|tests|check|checks|try|tries|confirm|confirms)\b.*\bon (?:my|the|your) (?:i?phone|ipad|watch)\b(?!\s+simulator)`,
  String.raw`\binstall(?:s|ed)?\b.*\bon (?:my|your) (?:i?phone|ipad|watch|device|mac)\b`,
].join("|"), "iu");

const namesOwnerAction = (text) => OWNER_ACTOR.test(String(text ?? "").trim());

/** Each label through checkText, and no two equal (case-insensitive). */
export function checkLabels(labels, existing = []) {
  const seen = new Set(existing.map((label) => String(label).trim().toLowerCase()));
  return labels.map((label) => {
    const text = checkText("label", label, { flag: "step" });
    if (namesOwnerAction(text)) {
      throw refuse(`step "${text}" is something the owner does; a plan holds only your own work. Owner actions are an ask (relo ask "…" --approval) or a note, never a step`, "--plan");
    }
    const key = text.toLowerCase();
    if (seen.has(key)) throw refuse(`step "${text}" appears twice. Name each step for what happens, e.g. ${EXAMPLES}.`, "--steps");
    seen.add(key);
    return text;
  });
}

/**
 * The card text of an activity start/update body: title (goal), status, detail and progress label, plus the
 * step labels this command sends (`labels`; a card's stored labels are not re-checked). Throws on the first refusal.
 */
export function checkCardText(body, { labels } = {}) {
  if (body.title !== undefined) checkText("goal", body.title, { flag: "--title" });
  if (body.status !== undefined) checkText("status", body.status, { goal: body.title });
  if (body.detail != null) checkText("detail", body.detail, { words: false });
  if (body.progressLabel != null) checkText("label", body.progressLabel, { flag: "--progress-label", words: false });
  if (labels !== undefined) checkLabels(labels);
  return body;
}
