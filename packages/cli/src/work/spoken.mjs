// The spoken frame (ADR 0015): every line Relo for Mac says is "<Kind>: <name>. <gist>". The CLI shortens a
// deliver's or finish's outcome into the gist once, here at the edge, seals it as the card's `spoken` and echoes
// the whole line as `Mac says:`. Relo for Mac adds only the kind word and the name (ReloNotchKit's SpokenLine,
// held to the same golden file: packages/cli/test/fixtures/spoken-lines.json).
import { UsageError } from "../shared/errors.mjs";
import { VOICE_LEVELS } from "../shared/config.mjs";
import { namedPlace } from "../shared/repo.mjs";
import { envSetting } from "../shared/settings.mjs";

/** The first words of every line: one closed set, so a half-heard line still says whether it needs the owner. */
export const SPOKEN_KINDS = Object.freeze({
  question: "Needs you", failed: "Failed", yourTurn: "Your turn", finished: "Finished",
  working: "Working", paused: "Paused", stopped: "Stopped",
});

export const SPOKEN_LIMITS = Object.freeze({ nameWords: 4, gistWords: 20, urgentWords: 12, lineChars: 180 });

/**
 * How much Relo for Mac may say of work started here (ADR 0015 revision 1), and where that comes from: RELO_VOICE,
 * then the nearest folder or repository given one with `relo voice --project`, then `relo voice`'s default, then
 * verbose. off: nothing is said aloud; brief: the kind and the name; full: and the gist; verbose: and finished steps.
 * -> { level, via: "env"|"project"|"config"|"default" }
 */
export function voiceSetting(dependencies) {
  const fromEnv = envSetting("voice", dependencies.env)?.toLowerCase();
  if (VOICE_LEVELS.includes(fromEnv)) return { level: fromEnv, via: "env" };
  let voices = {};
  try { voices = dependencies.loadVoices?.() ?? {}; } catch { voices = {}; }
  const place = dependencies.cwd ? namedPlace(dependencies.cwd, { names: voices }) : undefined;
  if (place?.via === "config") return { level: place.name, via: "project", root: place.root };
  if (voices["*"]) return { level: voices["*"], via: "config" };
  return { level: "verbose", via: "default" };
}

/** What an agent writes for the ear at each level, said once in the start echo. */
export function voiceNote({ level, via }) {
  const source = via === "env" ? "RELO_VOICE" : via === "project" ? "this project's setting" : via === "config" ? "relo voice" : "the default";
  switch (level) {
    case "off": return `voice is off here (${source}): Relo for Mac says nothing of this work; write no --say`;
    case "brief": return `voice is brief here (${source}): Relo for Mac says only "<Kind>: <name>."; --spoken-name matters, --say is not said`;
    default: return `voice is ${level} here (${source}): Relo for Mac says "<Kind>: <name>. <gist>"${level === "verbose" ? " and each finished step" : ""}. Name steps for the ear; on deliver and finish pass --say "<what happened, for the ear>" (at most 20 words; a failure, 12)`;
  }
}

/** Words a cut never ends on. */
const BREAKERS = new Set(["for", "on", "against", "with", "and", "so", "to", "in", "from", "by", "that", "of", "at", "into",
  "while", "because", "but", "or", "the", "a", "an", "then", "is", "are", "now", "its", "their", "as"]);

const VERSION = /\bv?\d+(?:\.\d+){1,3}\b/u;
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/u;
const ID = /\b(?:wrk|act|int|ntf|ses)_[A-Za-z0-9-]+/u;
const LINK = /https?:\/\/|\b[\w-]+(?:\.[\w-]+)*\.(?:ai|com|dev|io|net|org|app)\b/iu;
/** A file name; a product named like one ("Node.js", "Next.js": one capitalized word) is a name, not a file. */
const FILE = /\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(?:swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt)\b/u;
const PATHISH = /(?:^|\s)(?:~|\.{1,2})?\/[\w.@-]+|[\w.@-]+\/[\w.@-]+\//u;

/** What a spoken line may not carry (versions, hashes, ids, links, file names, paths), or null. */
export function spokenInventory(text) {
  const s = String(text ?? "");
  if (VERSION.test(s)) return "a version number";
  if (HASH.test(s)) return "a commit hash";
  if (ID.test(s)) return "an id";
  if (LINK.test(s)) return "a link";
  if (FILE.test(s)) return "a file name";
  if (PATHISH.test(s)) return "a path";
  return null;
}

/**
 * The rules for the ear on top of the content filter's (checkText): `--say` at most twenty words (twelve for a failure), `--spoken-name` at
 * most four, neither with a version, hash, id, link, file name or path. Returns the text or throws a usage refusal.
 */
export function checkSpoken(field, text, flag, { urgent = false } = {}) {
  const max = field === "name" ? SPOKEN_LIMITS.nameWords : urgent ? SPOKEN_LIMITS.urgentWords : SPOKEN_LIMITS.gistWords;
  const count = text.split(" ").length;
  if (count > max) throw refuse(`${flag} is ${count} words; it is said aloud, so at most ${max}.`, flag);
  const inventory = spokenInventory(text);
  if (inventory) throw refuse(`${flag} contains ${inventory}; it is said aloud, and a voice never reads one. Say what it means ("the iPhone app is on TestFlight").`, flag);
  return text;
}

function refuse(message, flag) {
  return Object.assign(new UsageError(`Refused: ${message}`, { hint: `Next: run it again with ${flag} "…"` }), { code: "CONTENT_REFUSED" });
}

/** Markdown, glyphs, links, paths and ids as words (the Mac's `SpokenLine.clean`). */
export function cleanSpoken(text) {
  let s = String(text ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/([^/\s]+)\S*/gu, "$1")
    // A Windows path (C:\Users\me\notes.md, ~\.claude\agents) is read as its last name too, like a POSIX one below.
    .replace(/(?:[A-Za-z]:|~|\.{1,2})?(?:\\[\w.@-]+){2,}\\?/gu, (path) => path.split("\\").filter(Boolean).pop() ?? "")
    .replace(/(?:~|\.{1,2}|[\w.@-]+)?(?:\/[\w.@-]+){2,}\/?/gu, (path) => path.split("/").filter(Boolean).pop() ?? "");
  const rules = [
    [/`{1,3}/gu, ""],
    [/\*\*|__|(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)/gu, ""],
    [/^\s*(?:#+|[-*+]|\d+\.)\s+/gmu, ""],
    [/\b(?:wrk|act|int|ntf|ses)_[A-Za-z0-9-]+\b/gu, ""],
    [/\s*[·•|]\s*/gu, ", "],
    [/…|\.{3}/gu, "."],
    [/[✓✔✗✘→←]/gu, ""],
  ];
  for (const [pattern, template] of rules) s = s.replace(pattern, template);
  return tidy(s);
}

function tidy(text) {
  return text
    .replace(/\s+([,.!?:;])/gu, "$1")
    .replace(/([,:;])\s*[,:;]+/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,;:.]+|[\s,;:]+$/gu, "");
}

/** The text without what a voice never reads: parentheses, versions, builds, hashes, codes, file names, links. */
export function stripSpoken(text) {
  let s = cleanSpoken(text);
  const rules = [
    [/\([^)]*\)/gu, ""],
    [/^v?\d+(?:\.\d+){1,3}\b/u, "The new version"],
    [/\b(?:(?:in|to|on|at)\s+)?(?:build\s+)?v?\d+(?:\.\d+){1,3}\b/giu, ""],
    [/\bbuild\s+\d+\b/giu, ""],
    [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gu, ""],
    [/,?\s*\bcode\s+[A-Z0-9]{4}-[A-Z0-9]{4}\b/giu, ""],
    [/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gu, ""],
    [/\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(?:swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt|SWIFT|MD|JSON)\b/gu, ""],
    [/\b[\w-]+(?:\.[\w-]+)*\.(?:ai|com|dev|io|net|org|app)\b/giu, ""],
  ];
  for (const [pattern, template] of rules) s = s.replace(pattern, template);
  s = tidy(s).replace(/\b(?:server|cli|iphone|ios|phone|mac)(?:\s*,\s*(?:server|cli|iphone|ios|phone|mac))+\b/giu, "");
  return tidy(s);
}

/** At most `max` words, cut at a word, never ending on a word like "the" or "and". */
export function capWords(text, max) {
  let words = String(text ?? "").split(" ").filter(Boolean);
  if (words.length > max) {
    words = words.slice(0, max);
    while (words.length > 2 && BREAKERS.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ""))) words.pop();
  }
  return words.join(" ").replace(/^[\s,;:]+|[\s,;:]+$/gu, "");
}

const wordCount = (text) => String(text ?? "").split(" ").filter(Boolean).length;

/** How the work is called aloud: a declared name, else the goal's head (before a colon or dash), at most four words. */
export function spokenName(goal, name) {
  if (name) return capWords(stripSpoken(name), SPOKEN_LIMITS.nameWords);
  let s = stripSpoken(goal);
  for (const sep of [":", " — ", " – ", " - ", "(", ";", ". "]) {
    const at = s.indexOf(sep);
    if (at > 0 && wordCount(s.slice(0, at)) >= 2) s = s.slice(0, at);
  }
  return capWords(s, SPOKEN_LIMITS.nameWords);
}

const sentence = (text, end = ".") => (/[.!?]$/u.test(text) ? text : `${text}${end}`);

/**
 * An outcome as its gist: the first sentence's phrases in order, as many as fit in twenty words, stopping at the
 * first one that is inventory (a version list, a hash, a link): what happened, then what it means; null when
 * nothing is left.
 */
export function outcomeGist(outcome, { urgent = false } = {}) {
  const budget = urgent ? SPOKEN_LIMITS.urgentWords : SPOKEN_LIMITS.gistWords;
  const s = cleanSpoken(outcome).replace(/\([^)]*\)/gu, "");
  const first = s.split(/[.!?](?:\s|$)/u)[0] ?? "";
  // Phrases end at punctuation, and before "and I", "but it" (a new clause about the same work).
  const phrases = first.split(/[;:—]|,\s+|\s+(?=(?:and|but|so)\s+(?:I|we|it|they|you)\b)/u).map((phrase) => phrase.trim()).filter(Boolean);
  // A failure's news is its reason: a headline that only says it failed ("Release gates failed") gives way to it.
  if (urgent && phrases.length > 1 && /\bfail(?:ed|s|ure)?\b/iu.test(phrases[0]) && !spokenInventory(phrases[1])) phrases.shift();
  const kept = [];
  let words = 0;
  for (const phrase of phrases) {
    const said = stripSpoken(phrase);
    const count = wordCount(said);
    if (kept.length === 0) {
      if (count === 0) continue;
    } else if (spokenInventory(phrase) || count < 2 || words + count > budget) break;
    kept.push(said);
    words += count;
  }
  const gist = capWords(kept.join(", "), budget);
  return gist ? sentence(upper(gist)) : null;
}

const upper = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** A question's gist: its first sentence (a relayed permission by its tool alone), at most twelve words: it is urgent. */
export function questionGist(prompt) {
  const allow = /^Allow (\w+): /u.exec(String(prompt ?? ""));
  if (allow) return `Allow ${allow[1]}?`;
  const s = stripSpoken(prompt);
  const match = /^(.*?)([.!?])(?:\s|$)/u.exec(s);
  const head = match ? match[1] : s;
  const gist = capWords(head, SPOKEN_LIMITS.urgentWords);
  return gist ? `${gist}${match?.[2] === "." || match?.[2] === "!" ? match[2] : "?"}` : null;
}

/** The gist an agent wrote (`--say`), as words to say. */
export const saidGist = (say) => {
  const s = cleanSpoken(say);
  return s ? sentence(s) : null;
};

/** The whole line: "<Kind>: <name>. <gist>", at most 120 characters, cut at a word. */
export function spokenLine(kind, { goal, name, gist } = {}) {
  const lead = SPOKEN_KINDS[kind];
  if (!lead) throw new Error(`unknown spoken kind ${kind}`);
  const called = spokenName(goal, name);
  let line = called ? `${lead}: ${sentence(called)}` : `${lead}.`;
  if (gist && gist.replace(/[.!?]$/u, "").toLowerCase() !== called.toLowerCase()) line += ` ${gist}`;
  if (Array.from(line).length <= SPOKEN_LIMITS.lineChars) return line;
  const head = Array.from(line).slice(0, SPOKEN_LIMITS.lineChars).join("");
  return sentence(capWords(head.slice(0, head.lastIndexOf(" ")), Infinity).replace(/[,;:]$/u, ""), kind === "question" ? "?" : ".");
}
