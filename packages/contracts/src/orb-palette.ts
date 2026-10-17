/**
 * The Relo core's colours on Now, shared by the server (which paints the core in the first frame,
 * before any script) and the Dashboard (which drives the WebGL scene), so both paint the same orb.
 *
 * Pure data and mapping, no DOM: the owner's day (what needs them, what runs, today's finished
 * work by meaning) in, three CSS colours out (--orb-1 bright, --orb-2 body, --orb-3 peaks).
 */

/** What a thing on Now means (the iPhone's NowSignal); every colour maps to one meaning. */
export type OrbSignal = "done" | "running" | "needsYou" | "attention" | "failed" | "message";

/** Display order; ties between meanings resolve in this order. */
export const ORB_SIGNALS: readonly OrbSignal[] = ["done", "running", "needsYou", "attention", "failed", "message"];

/** The one CSS colour for each meaning (lowercase hex, as the scene takes it). */
export const ORB_SIGNAL_COLORS: Readonly<Record<OrbSignal, string>> = {
  done: "#34d399",
  running: "#5ce1ff",
  needsYou: "#ff8a3d",
  attention: "#facc15",
  failed: "#f43f5e",
  message: "#8b7cff",
};

/** Today's work by meaning. */
export type OrbMix = Partial<Record<OrbSignal, number>>;

/** The deck's steady state: what its centre counts and what colour leads the core. */
export type DeckState = "clear" | "running" | "needsYou";

/** The leading meaning per state: mint when all is clear, cyan while work runs, orange when you are needed. */
export const DECK_LEAD: Readonly<Record<DeckState, OrbSignal>> = { clear: "done", running: "running", needsYou: "needsYou" };

/**
 * Each state's plasma as an analogous ramp (bright, body, peaks), as the landing's cyan, violet and
 * magenta: neighbouring hues churn into one calm surface, where clashing ones read as camouflage.
 */
export const ORB_RAMPS: Readonly<Record<DeckState, readonly [string, string, string]>> = {
  clear: ["#34d399", "#2dd4bf", "#8b7cff"],
  running: ["#5ce1ff", "#8b7cff", "#d65cf0"],
  needsYou: ["#ff8a3d", "#ff6b57", "#d65cf0"],
};

/** Quiet work desaturates the running ramp by 30%; an offline page fades every colour 40% toward grey. */
export const QUIET_DESATURATION = 0.3;
export const OFFLINE_GREYING = 0.4;

/** A colour moved `amount` (0...1) toward its own luminance grey, as lowercase CSS hex. */
export function toward(hex: string, amount: number): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const grey = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  return `#${rgb
    .map((channel) => Math.round(channel + (grey - channel) * amount))
    .map((channel) => Math.min(255, Math.max(0, channel)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** What drives the core, from the server's summary alone: work moving, only quiet work, or nothing. */
export type DeckBasis = "moving" | "quiet" | "calm";

/** The summary fields the basis reads (structural: the Now summary, or test literals). */
export type DeckBasisSummary = {
  running: readonly { owner: { state: string } }[];
  quiet: readonly { owner: { state: string } }[];
  sessions: { sessions: readonly { phase: string | null; workId: string | null }[] };
};

const QUIET_STATES = new Set(["working_quietly", "stale", "stopped_responding", "no_signal"]);

/** Moving work or a working session without a card is moving; otherwise quiet work is quiet; else calm. */
export function deckBasis(summary: DeckBasisSummary | null | undefined): DeckBasis {
  const items = summary ? [...summary.running, ...summary.quiet] : [];
  const moving = items.filter((item) => item.owner.state === "moving").length;
  const quiet = items.filter((item) => QUIET_STATES.has(item.owner.state)).length;
  const sessions = summary?.sessions.sessions.filter((row) => row.phase === "working" && !row.workId).length ?? 0;
  return moving + sessions > 0 ? "moving" : quiet > 0 ? "quiet" : "calm";
}

/** The colour state: anything needing the owner is orange; work under way (moving or quiet) cyan; else mint. */
export function deckColorState(needsYou: number, basis: DeckBasis): DeckState {
  if (needsYou > 0) return "needsYou";
  return basis === "calm" ? "clear" : "running";
}

/**
 * The core's three colours: the state's ramp, with today's biggest other meaning (not the state's
 * own lead) lighting the brightest peaks (ties go to the earlier meaning in display order). Quiet
 * work desaturates the running ramp; offline greys every colour.
 */
export function deckColors(
  mix: OrbMix,
  state: DeckState,
  tint: { quiet?: boolean | undefined; offline?: boolean | undefined } = {},
): [string, string, string] {
  const lead = DECK_LEAD[state];
  const [bright, body, peaks] = ORB_RAMPS[state];
  let other: OrbSignal | null = null;
  let best = 0;
  for (const signal of ORB_SIGNALS) {
    const count = mix[signal] ?? 0;
    if (signal === lead || !(count > 0) || count <= best) continue;
    other = signal;
    best = count;
  }
  const amount = tint.offline ? OFFLINE_GREYING : tint.quiet && state === "running" ? QUIET_DESATURATION : 0;
  const colors: [string, string, string] = [bright, body, other ? ORB_SIGNAL_COLORS[other] : peaks];
  return amount ? (colors.map((color) => toward(color, amount)) as [string, string, string]) : colors;
}

/** The fields of a Dashboard notification row the deck reads (the server's summary shape). */
export type DeckNotification = {
  kind: string;
  state: string;
  createdAt: string | null;
  activity?: { state: string; outcome?: string | null | undefined; updatedAt: string | null } | null | undefined;
  question?: { state: string; expiresAt: string | null } | null | undefined;
};

type DeckOutcome = "running" | "needsYou" | "done" | "answered" | "declined" | "failed" | "attention" | "message";

const ANSWERED: Record<string, "answered" | "declined"> = {
  approved: "answered",
  yes: "answered",
  replied: "answered",
  responded: "answered",
  canceled: "answered",
  denied: "declined",
  no: "declined",
};

function outcomeOf(row: DeckNotification, now: number): DeckOutcome {
  if (row.kind === "live_activity") {
    const activity = row.activity;
    if (!activity) return row.state === "active" ? "running" : "attention";
    if (activity.state === "active") return "running";
    if (activity.state === "expired" || activity.state === "replaced") return "attention";
    return activity.outcome === "completed" ? "done" : activity.outcome === "failed" ? "failed" : "attention";
  }
  const question = row.question;
  if (!question) return "message";
  if (question.state === "pending" && (!question.expiresAt || Date.parse(question.expiresAt) > now)) return "needsYou";
  return ANSWERED[question.state] ?? "attention";
}

const SIGNAL_OF: Record<DeckOutcome, OrbSignal> = {
  running: "running",
  needsYou: "needsYou",
  done: "done",
  answered: "done",
  declined: "attention",
  failed: "failed",
  attention: "attention",
  message: "message",
};

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/**
 * The deck's readings from the page's rows and the server's counts: today's rows (the local day of
 * `now`), today's done and answered rows, and today's mix (finished rows by meaning, plus what needs
 * the owner and what runs). Mirrors the Dashboard's `nowMetrics` / `nowMix`.
 */
export function deckReadings(input: {
  notifications: readonly DeckNotification[];
  running: number;
  needsYou: number;
  now: Date;
}): { today: number; done: number; mix: OrbMix } {
  const today = dayKey(input.now);
  const mix: OrbMix = {};
  let todays = 0;
  let done = 0;
  for (const row of input.notifications) {
    const at = row.activity?.updatedAt ?? row.createdAt;
    const date = at ? new Date(at) : null;
    if (!date || !Number.isFinite(date.valueOf()) || dayKey(date) !== today) continue;
    todays += 1;
    const outcome = outcomeOf(row, input.now.valueOf());
    if (outcome === "done" || outcome === "answered" || outcome === "declined") done += 1;
    if (outcome === "running" || outcome === "needsYou") continue;
    const signal = SIGNAL_OF[outcome];
    mix[signal] = (mix[signal] ?? 0) + 1;
  }
  if (input.needsYou > 0) mix.needsYou = (mix.needsYou ?? 0) + input.needsYou;
  if (input.running > 0) mix.running = (mix.running ?? 0) + input.running;
  return { today: todays, done, mix };
}
