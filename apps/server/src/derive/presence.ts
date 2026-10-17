import type { AgentSessionEvidence } from "@relo/notification-contracts";
import { ms,T } from "./clock.js";

/**
 * Presence: what a session is doing right now, read from its observed state alone. This is the one
 * place the observed `phase` is read (plan 14, workstream 5): the card (bindAgentSessionEvidence) and
 * the Sessions row both call `presence()` then `reconcile()`, so they cannot disagree. Pure: the CLI
 * reports, the server keeps the clock.
 *
 *   working     seen within T_quiet, or a tool/subagent open for less than T_retire
 *   needs_input a permission or input prompt, up to T_history (and its heartbeat current, when the session sends one)
 *   your_turn   the turn stopped less than T_yourTurn ago
 *   silent      a turn that was running with no sign of life
 *   idle        nothing is happening (a stopped turn past T_yourTurn, an expired prompt, a session never prompted)
 *   ended       the session closed
 */
export type PresenceKind = "working" | "needs_input" | "your_turn" | "silent" | "idle" | "ended";

export type ObservedSession = Omit<NonNullable<AgentSessionEvidence["session"]>,"openToolSince"> & {
  openToolSince?: string | null | undefined;
};

export type Presence = {
  readonly kind: PresenceKind;
  /** When the session entered the state this kind was read from (the anchor of the declared-write rules). */
  readonly since: number;
  /** Instants after which this kind may change by time alone, all later than `now`. */
  readonly changesAt: readonly number[];
  /** False for a session that started and never prompted (Sessions shows it from its first prompt). */
  readonly prompted: boolean;
  /** An idle kind that follows a stopped turn (the card says "session idle"). */
  readonly afterTurn: boolean;
};

const later = (now: number,...at: (number | null)[]): number[] =>
  at.flatMap((instant) => instant !== null && instant > now ? [instant] : []).sort((a,b) => a - b);

export function presence(observed: ObservedSession,now: number): Presence {
  const since = ms(observed.phaseSince);
  const seen = ms(observed.lastSeenAt);
  const tool = observed.openToolSince ? ms(observed.openToolSince) : null;
  const make = (kind: PresenceKind,changesAt: number[],extra: Partial<Pick<Presence,"prompted" | "afterTurn">> = {}): Presence =>
    ({ kind,since,changesAt,prompted: true,afterTurn: false,...extra });
  switch (observed.phase) {
    case "ended": return make("ended",[]);
    case "working": {
      const until = Math.max(seen + T.quiet,tool === null ? -Infinity : tool + T.retire);
      return now < until ? make("working",later(now,until)) : make("silent",[]);
    }
    case "waiting": {
      if (now - since >= T.history) return make("idle",[]);
      // A session with a heartbeat source (its MCP server) proves it is alive by the heartbeat: once that stops for T_quiet it is silent.
      const beat = observed.heartbeatAt ? Math.max(ms(observed.heartbeatAt),seen) : null;
      if (beat !== null && now - beat >= T.quiet) return make("silent",[]);
      return make("needs_input",later(now,since + T.history,beat === null ? null : beat + T.quiet));
    }
    case "stopped":
      return now - since < T.yourTurn ? make("your_turn",later(now,since + T.yourTurn)) : make("idle",[],{ afterTurn: true });
    case "open": return make("idle",[],{ prompted: false });
  }
}

/** The session ended (time-independent); for evidence that asks only that. */
export const hasEnded = (observed: ObservedSession): boolean => observed.phase === "ended";

/** The declared side of one session, as the rules below need it. */
export type DeclaredSide = { lastDeclaredAt: number | null; waitingSince: number | null };

/**
 * The declared rules, applied once for both surfaces:
 *  - a declared write after `since` cancels `your_turn` and `needs_input` (the agent went on);
 *  - a declared `--waiting` (a background job, CI) keeps the session `working`, and so does a declared write
 *    within T_fresh (after `since`, when the turn stopped) over `your_turn`, `silent` and `idle`;
 *  - a permission prompt and an ended session are never overridden by a wait.
 */
export function reconcile(observed: Presence,declared: DeclaredSide,now: number): Presence {
  let kind = observed.kind;
  const wrote = declared.lastDeclaredAt !== null && declared.lastDeclaredAt > observed.since;
  if ((kind === "your_turn" || kind === "needs_input") && wrote) kind = "idle";
  const waiting = declared.waitingSince !== null && now - declared.waitingSince < T.retire;
  // A fresh declared write wins over a silent or idle session; after a stopped turn it must come after the stop.
  const fresh = declared.lastDeclaredAt !== null && now - declared.lastDeclaredAt < T.fresh
    && (wrote || kind === "silent" || (kind === "idle" && !observed.afterTurn));
  if ((kind === "your_turn" || kind === "silent" || kind === "idle") && (waiting || fresh)) {
    return { ...observed,kind: "working",
      // Held by the longer of the two declared reasons.
      changesAt: [Math.max(waiting ? declared.waitingSince! + T.retire : -Infinity,fresh ? declared.lastDeclaredAt! + T.fresh : -Infinity)] };
  }
  return kind === observed.kind ? observed : { ...observed,kind,changesAt: [] };
}
