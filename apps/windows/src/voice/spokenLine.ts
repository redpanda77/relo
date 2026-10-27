// What the notch says (ADR 0015): one frame for every line, "<Kind>: <name>. <gist>", so a half-heard line still says whether it
// needs the owner. Ported from apps/notch/ReloNotchKit/Sources/ReloNotchKit/SpokenLine.swift and held to the same golden file
// as the CLI and the Mac (packages/cli/test/fixtures/spoken-lines.json). The kind is a closed set of words; the name is the work's
// declared spoken name, else the goal's first words; the gist is the card's sealed `spoken` (the CLI shortened the outcome, or the
// agent wrote `--say`), a question's first sentence, or the current step. The notch never shortens an outcome itself: without a
// sealed gist it says the frame alone. It adds no facts; a sealed card this PC could not open says nothing.
//
// One difference from Swift: regular expressions here are JavaScript's, whose \w and \b are ASCII; the Mac's (ICU) are Unicode.
// Lines are mostly English (the CLI composes them), and the golden file passes either way.

import type { Tone } from "../relo/presentation"

/** The longest line spoken, cut at a word. */
export const MAX_LENGTH = 180
const NAME_WORDS = 4
const GIST_WORDS = 20
/** A question or a failure is urgent: the fewest ideas (ADR 0015 revision 1). */
const URGENT_WORDS = 12

/** How much is said: nothing, the kind and the name, and the gist, and finished steps. */
export type Detail = "off" | "brief" | "full" | "verbose"
const DETAILS: readonly Detail[] = ["off", "brief", "full", "verbose"]

export function detailFrom(name: string | null | undefined): Detail | null {
  const lower = name?.toLowerCase()
  return DETAILS.find((d) => d === lower) ?? null
}

export const minDetail = (a: Detail, b: Detail): Detail => (DETAILS.indexOf(a) <= DETAILS.indexOf(b) ? a : b)
const atLeast = (a: Detail, b: Detail): boolean => DETAILS.indexOf(a) >= DETAILS.indexOf(b)

/**
 * The part of a card the line is made of: a presentation `Row`, plus the sealed words for the ear the notch opened for it
 * (`SpokenText` on the Mac: the gist, the work's spoken name, the producer's voice level). A `Row` is a `SpokenCard`.
 */
export interface SpokenCard {
  id: string
  title: string
  tone: Tone
  unreadable: boolean
  currentStep: string | null
  stepsDone: number | null
  stepsTotal: number | null
  /** The card's sealed gist (`spoken`). */
  spoken?: string | null
  /** How the work is called aloud (`--spoken-name`). */
  spokenName?: string | null
  /** The producer's voice level for this card (`relo voice`); absent from an older CLI or a readable card. */
  spokenVoice?: Detail | null
}

/** The detail a card is said at: the lower of the owner's and the card's. */
export function detailFor(card: Pick<SpokenCard, "spokenVoice">, owner: Detail): Detail {
  return minDetail(owner, card.spokenVoice ?? owner)
}

const chars = (s: string): string[] => Array.from(s)
const length = (s: string): number => chars(s).length
const first = (s: string): string => chars(s)[0] ?? ""
const dropFirst = (s: string): string => chars(s).slice(1).join("")
const trimSet = (s: string, set: string): string => {
  const c = chars(s)
  let a = 0
  let b = c.length
  while (a < b && set.includes(c[a]!)) a++
  while (b > a && set.includes(c[b - 1]!)) b--
  return c.slice(a, b).join("")
}
const wordCount = (s: string): number => s.split(" ").filter(Boolean).length

/** A finished step at the Verbose detail: "Working: Notch redesign. 3 of 5 done, now build the list." */
export function progress(card: SpokenCard, owner: Detail): string | null {
  if (card.unreadable || detailFor(card, owner) !== "verbose") return null
  const done = card.stepsDone
  const total = card.stepsTotal
  if (done === null || total === null || total <= 0) return null
  const name = spokenName(card.title, card.spokenName)
  if (!name) return null
  const step = card.currentStep === null ? null : stepGist(card.currentStep)
  const now = step === null ? "." : `, now ${first(step).toLowerCase()}${dropFirst(step)}`
  return line("Working", name, `${done} of ${total} done${now}`, false)
}

export interface TextOptions {
  /** A question's prompt (the sealed question), for the gist of a card that needs the owner. */
  prompt?: string | null
  /** The owner's detail (Settings); the play button passes "full": the owner asked for it. */
  owner?: Detail
  /** Without the kind word, the line starts at the name: a cue already said what kind of update it is. */
  kind?: boolean
}

/** The card's line at the owner's detail, or null when there is nothing to say. */
export function text(card: SpokenCard, options: TextOptions = {}): string | null {
  const owner = options.owner ?? "full"
  if (card.unreadable) return null
  const detail = detailFor(card, owner)
  if (!atLeast(detail, "brief")) return null
  const name = spokenName(card.title, card.spokenName)
  if (!name) return null
  const sealed = card.spoken ? clean(card.spoken) : ""
  const gistOfSealed = sealed ? sentence(sealed) : null
  let kind: string
  let gist: string | null
  switch (card.tone) {
    case "needsYou":
      kind = "Needs you"
      gist = options.prompt ? questionGist(options.prompt) : null
      break
    case "failed":
      kind = "Failed"
      gist = gistOfSealed
      break
    case "yourTurn":
      kind = "Your turn"
      gist = gistOfSealed
      break
    case "done":
      kind = "Finished"
      gist = gistOfSealed
      break
    case "dropped":
    case "leftUnfinished":
      kind = "Stopped"
      gist = null
      break
    case "paused":
      kind = "Paused"
      gist = null
      break
    case "working":
    case "quiet":
      kind = "Working"
      gist = card.currentStep === null ? null : stepGist(card.currentStep)
      break
  }
  return line(options.kind === false ? null : kind, name, atLeast(detail, "full") ? gist : null, card.tone === "needsYou")
}

export function line(kind: string | null, name: string, gist: string | null, question: boolean): string {
  let result = kind ? `${kind}: ${sentence(name)}` : sentence(name)
  if (gist && trimSet(gist, ".!?").toLowerCase() !== name.toLowerCase()) result += ` ${gist}`
  if (length(result) <= MAX_LENGTH) return result
  const head = chars(result).slice(0, MAX_LENGTH).join("")
  const at = head.lastIndexOf(" ")
  const cut = at === -1 ? head : head.slice(0, at)
  return sentence(trimSet(cut, ",;: "), question ? "?" : ".")
}

/** How the work is called aloud: the declared name, else the goal's head (before a colon or dash), at most four words. */
export function spokenName(goal: string, declared?: string | null): string {
  if (declared) return capWords(strip(declared), NAME_WORDS)
  let s = strip(goal)
  for (const separator of [":", " — ", " – ", " - ", "(", ";", ". "]) {
    const at = s.indexOf(separator)
    if (at !== -1 && wordCount(s.slice(0, at)) >= 2) s = s.slice(0, at)
  }
  return capWords(s, NAME_WORDS)
}

/** A question's gist: its first sentence (a relayed permission, "Allow Bash: …?", by its tool alone), at most twelve words. */
export function questionGist(prompt: string): string | null {
  const allow = /^Allow \w+(?=: )/.exec(prompt)
  if (allow) return `${allow[0]}?`
  const s = strip(prompt)
  let head = s
  let end = "?"
  const stop = /[.!?](\s|$)/.exec(s)
  if (stop) {
    head = s.slice(0, stop.index)
    const mark = s[stop.index]!
    if (mark !== "?") end = mark
  }
  const gist = capWords(head, URGENT_WORDS)
  return gist ? gist + end : null
}

/**
 * The current step said by the play button, shortened as the CLI shortens an outcome (`outcomeGist`): the first sentence's
 * phrases in order, as many as fit in twenty words, stopping at the first that is inventory.
 */
export function stepGist(step: string): string | null {
  const s = clean(step).replace(/\([^)]*\)/g, "")
  const stop = /[.!?](\s|$)/.exec(s)
  const firstSentence = stop ? s.slice(0, stop.index) : s
  const phrases = firstSentence
    .replace(/\s+(?=(and|but|so)\s+(I|we|it|they|you)\b)/g, "\u001F")
    .split(/[;:—\u001F]/)
    .flatMap((part) => part.split(", "))
    .map((part) => part.trim())
    .filter((part) => part !== "")
  const kept: string[] = []
  let words = 0
  for (const phrase of phrases) {
    const said = strip(phrase)
    const count = wordCount(said)
    if (kept.length === 0) {
      if (count === 0) continue
    } else if (isInventory(phrase) || count < 2 || words + count > GIST_WORDS) {
      break
    }
    kept.push(said)
    words += count
  }
  const gist = capWords(kept.join(", "), GIST_WORDS)
  return gist ? sentence(first(gist).toUpperCase() + dropFirst(gist)) : null
}

const INVENTORY: readonly RegExp[] = [
  /\bv?\d+(\.\d+){1,3}\b/,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
  /\b(wrk|act|int|ntf|ses)_[A-Za-z0-9-]+/,
  /https?:\/\/|\b[\w-]+(\.[\w-]+)*\.(ai|com|dev|io|net|org|app)\b/i,
  /\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt)\b/,
  /(^|\s)(~|\.{1,2})?\/[\w.@-]+|[\w.@-]+\/[\w.@-]+\//,
]

/** A version, hash, id, link, file name or path: what a voice never reads (the CLI's `spokenInventory`). */
export function isInventory(s: string): boolean {
  return INVENTORY.some((pattern) => pattern.test(s))
}

const PATH = /(?:~|\.{1,2}|[\w.@-]+)?(?:\/[\w.@-]+){2,}\/?/g

const CLEAN_RULES: readonly [RegExp, string][] = [
  [/`{1,3}/g, ""],
  [/\*\*|__|(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)/g, ""],
  [/^\s*(#+|[-*+]|\d+\.)\s+/gm, ""], // headings and list markers
  [/\b(wrk|act|int|ntf|ses)_[A-Za-z0-9-]+\b/g, ""],
  [/\s*[·•|]\s*/g, ", "],
  [/…|\.{3}/g, "."],
  [/[✓✔✗✘→←]/g, ""],
]

/** The text as words to say: no markdown, glyphs as pauses, links by host, paths by their last name, ids left out. */
export function clean(input: string): string {
  let s = input.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/([^/\s]+)\S*/g, "$1")
  s = s.replace(PATH, (match) => match.split("/").filter(Boolean).pop() ?? "")
  for (const [pattern, template] of CLEAN_RULES) s = s.replace(pattern, template)
  return tidy(s)
}

const STRIP_RULES: readonly [RegExp, string][] = [
  [/\([^)]*\)/g, ""],
  [/^v?\d+(\.\d+){1,3}\b/g, "The new version"],
  [/\b((in|to|on|at)\s+)?(build\s+)?v?\d+(\.\d+){1,3}\b/gi, ""],
  [/\bbuild\s+\d+\b/gi, ""],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, ""],
  [/,?\s*\bcode\s+[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, ""],
  [/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, ""],
  [/\b(?![A-Z][a-z]+\.js\b)[\w-]+\.(swift|md|ts|tsx|mjs|js|json|sh|yml|yaml|html|css|py|txt)\b/g, ""],
  [/\b[\w-]+(\.[\w-]+)*\.(ai|com|dev|io|net|org|app)\b/gi, ""],
]

/** Clean, then without what a voice never reads: parentheses, versions, builds, hashes, codes, file names, links. */
export function strip(input: string): string {
  let s = clean(input)
  for (const [pattern, template] of STRIP_RULES) s = s.replace(pattern, template)
  s = tidy(s).replace(/\b(server|cli|iphone|ios|phone|mac)(\s*,\s*(server|cli|iphone|ios|phone|mac))+\b/gi, "")
  return tidy(s)
}

function tidy(s: string): string {
  return s
    .replace(/\s+([,.!?:;])/g, "$1")
    .replace(/([,:;])\s*[,:;]+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.]+|[\s,;:]+$/g, "")
}

/** Words a cut never ends on. */
const BREAKERS: ReadonlySet<string> = new Set([
  "for", "on", "against", "with", "and", "so", "to", "in", "from", "by", "that",
  "of", "at", "into", "while", "because", "but", "or", "the", "a", "an", "then", "is", "are", "now", "its", "their", "as",
])

/** At most `max` words, cut at a word, never ending on a word like "the" or "and". */
export function capWords(input: string, max: number): string {
  let words = input.split(" ").filter(Boolean)
  if (words.length > max) {
    words = words.slice(0, max)
    while (words.length > 2 && BREAKERS.has(words[words.length - 1]!.toLowerCase().replace(/[^\p{L}]/gu, ""))) words.pop()
  }
  return trimSet(words.join(" "), ",;: ")
}

/** Ends with a full stop (or `end`) unless it already ends a sentence. */
export function sentence(s: string, end = "."): string {
  const last = chars(s).pop()
  return last === undefined || ".!?".includes(last) ? s : s + end
}
