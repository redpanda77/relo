// The echo every relo work command prints (plan 04 §2.5): what is open, what the owner sees, what next.
// The owner line comes from the server's derived state (view.owner); the CLI never computes policy.
import { currentPath, isDelivered, lastRound, openRound, planLine, position } from "./plan.mjs";

export const shortId = (id) => (typeof id === "string" ? id.replace(/^(wrk_[0-9a-f]{8})[0-9a-f-]*$/u, "$1") : "wrk_?");
const q = (text) => `"${String(text ?? "").replace(/"/gu, '\\"')}"`;

/** The server's waiting is {reason, since}; local copies may hold the plain reason. */
const waitingText = (waiting) => (waiting && typeof waiting === "object" ? waiting.reason ?? "something" : waiting);
const waitingSince = (work) => (work?.waiting && typeof work.waiting === "object" ? work.waiting.since : work?.waitingSince ?? work?.lastWriteAt);

function hhmm(iso, now = new Date()) {
  if (!iso) return "?";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "?";
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()} ${time}`;
}

/** The Lock Screen words (plan UX U2): one rule in the contracts plan engine, the same for the CLI, the phone and the Now row. */
const countText = (p) => `${p.done} of ${p.total}${p.done >= p.total ? " ✓" : ""}`;
const shorten = (text, length) => (text.length > length ? `${text.slice(0, Math.max(1, length - 1)).trimEnd()}…` : text);
export function cardLine(work) {
  const line = planLine(work);
  if (line) return line;
  const text = work?.waiting ? `Waiting on ${waitingText(work.waiting)}` : (work?.status || work?.goal || "");
  return work?.progress ? [text, countText(work.progress)].filter(Boolean).join(" · ") : text;
}

export function stateLine(work, parked = []) {
  let line;
  if (!work) line = "nothing open";
  else if (work.lifecycle === "paused") line = `paused: ${shortId(work.id)} ${q(work.goal)}`;
  else {
    line = `open: ${shortId(work.id)} ${q(work.goal)}`;
    const plan = planLine(work);
    if (plan) line += `, ${plan}`;
  }
  return parked.length ? `${line}; parked: ${parked.length}` : line;
}

/**
 * What the owner sees for this work. `notch` is an account whose only screen is Relo for Mac (a local account, or
 * one with no phone): the words name the notch, never the Lock Screen or Now.
 */
export function ownerSees(work, now = new Date(), disposition, notch = false) {
  if (!work) return "Owner sees: (unknown: run relo state --sync)";
  const derived = work.owner?.state ?? work.owner?.kind ?? work.owner;
  // The notch is Relo for Mac on a Mac and Relo for Windows on a PC: name the machine only where it is a Mac.
  const notchName = process.platform === "darwin" ? "your Mac's notch" : "the Relo notch";
  const screen = notch ? `in ${notchName}` : "on the Lock Screen";
  const none = notch ? `nothing in ${notchName}` : "nothing on the Lock Screen";
  if (work.lifecycle === "finished" || work.result) {
    const result = work.result ?? "finished";
    if (result === "failed") return `Owner sees: the final card for 60 min and an alert: ${q(work.outcome)}`;
    if (result === "dropped") return `Owner sees: ${none}; History: ${q(work.outcome)}`;
    return `Owner sees: the final card for 15 min and one notification: ${q(work.outcome)}`;
  }
  if (isDelivered(work)) {
    const round = lastRound(work.plan);
    return disposition === "delivered"
      ? `Owner sees: the round's final card and one quiet notification: ${q(round.outcome ?? work.outcome)}; then it's the owner's turn`
      : `Owner sees: round ${round.n} delivered${round.outcome ? `: ${q(round.outcome)}` : ""}; it's the owner's turn${notch ? "" : " (Now)"}`;
  }
  if (work.lifecycle === "paused" || derived === "paused") {
    const plan = planLine({ ...work, lifecycle: "paused" });
    return `Owner sees: ${none}${notch ? "" : "; Now › Paused"}${plan ? ` (${q(plan)})` : ""}`;
  }
  if (derived === "needs_you") return notch ? "Owner sees: the notch opens with your question" : "Owner sees: your question on top of the Lock Screen, as a time-sensitive alert";
  if (derived === "stale") return `Owner sees: the card dimmed since ${hhmm(work.owner?.since, now)} (no update for 20 min); any update brightens it`;
  if (derived === "no_signal" || derived === "stopped_responding") return `Owner sees: ${none} (no update for 60 min)${notch ? "" : "; Now › Quiet"}. Any update brings the card back`;
  if (work.waiting) return `Owner sees: ${screen}, ${q(`Waiting on ${waitingText(work.waiting)}`)}`;
  return `Owner sees: ${screen}, ${q(cardLine(work))}`;
}

function questionLine(question, now) {
  if (!question) return undefined;
  const prompt = question.prompt ? q(question.prompt) : "your question";
  if (question.state === "pending" || question.state === "open") return `Question: ${prompt} (${question.type ?? "approval"}) waiting since ${hhmm(question.askedAt ?? question.createdAt, now)}`;
  if (question.late) return `Answer since you asked: ${question.state} ${prompt} at ${hhmm(question.answeredAt, now)} (late: not permission)`;
  if (["expired", "canceled", "closed"].includes(question.state)) return `Question: ${prompt} closed without an answer at ${hhmm(question.closedAt ?? question.answeredAt, now)}`;
  if (question.state) return `Answer: ${question.state} to ${prompt} at ${hhmm(question.answeredAt, now)}. To act on it: relo interaction wait ${question.id} (exit 0 = permission)`;
  return undefined;
}

function nextLine(work) {
  if (!work || work.lifecycle === "finished" || work.result) return 'Next: nothing open in this session. A new goal: relo work start --goal "…"';
  if (work.lifecycle === "paused") return 'Next: relo work resume  |  relo work finish --outcome "…"';
  const question = work.question;
  if (question && (question.state === "pending" || question.state === "open")) return `Next: waiting; the answer will show here (relo state). To wait now: relo interaction wait ${question.id}`;
  if (question && ["expired", "canceled", "closed"].includes(question.state)) return 'Next: don\'t proceed: ask again (relo ask "…" --approval) or pause with a reason (relo work pause --status "…")';
  if (question?.late) return 'Next: ask again before acting: relo ask "…" --approval';
  if (work.waiting) return `Next: relo work update --not-waiting --status "…"  (when ${waitingText(work.waiting)} is back)`;
  const steps = work.plan?.steps ?? [];
  const pos = position(work.plan);
  if (isDelivered(work)) return 'Next: the round is delivered. A follow-up on this goal: relo work start --round "<the request in a few words>" --plan "…"  |  goal done: relo work finish --outcome "…"';
  if (steps.length && pos.complete) return 'Next: done: relo work finish --outcome "…"  |  this request done, more of the goal to come: relo work deliver --outcome "…"  |  relo work update --add "…"';
  if (pos.current?.progress) return `Next: relo work update --progress ${Math.min(pos.current.progress.done + 1, pos.current.progress.total)}/${pos.current.progress.total}  |  relo work update --next-step`;
  if (pos.current) return pos.toGo === 0 ? 'Next: relo work update --next-step  |  relo work deliver --outcome "…"' : 'Next: relo work update --next-step';
  if (work.progress) return `Next: relo work update --progress ${Math.min(work.progress.done + 1, work.progress.total)}/${work.progress.total}  |  relo work deliver --outcome "…"`;
  return 'Next: relo work update --plan "…"  |  relo work deliver --outcome "…"';
}

const MARK = { done: "[x]", current: "[>]", open: "[ ]", skipped: "[-]" };

const roundOf = (step) => step.round ?? 1;
const roundName = (round, goal) => {
  const title = round.title ?? (round.n === 1 ? goal : undefined);
  return `Round ${round.n}${title ? ` ${q(shorten(String(title), 40))}` : ""}`;
};

const MAX_CLOSED_LINES = 5;

function stepLines(plan, goal) {
  const lines = [];
  // Closed rounds fold to one line each: the round, its title and what it delivered.
  // Only the newest few: a long work has dozens, and each line is repeated in the agent's context on every command.
  const closed = (plan?.rounds ?? []).filter((round) => round.state === "closed");
  if (closed.length > MAX_CLOSED_LINES) lines.push(`  … ${closed.length - MAX_CLOSED_LINES} earlier rounds`);
  for (const round of closed.slice(-MAX_CLOSED_LINES)) lines.push(`  [✓] ${roundName(round, goal)}${round.outcome ? `: ${shorten(String(round.outcome), 120)}` : ""}`);
  const open = openRound(plan);
  const steps = open && plan?.rounds ? (plan.steps ?? []).filter((s) => roundOf(s) === open.n) : open || !plan?.rounds ? plan?.steps ?? [] : [];
  const nested = (plan?.rounds?.length ?? 0) >= 2 && open;
  if (nested) lines.push(`  ${roundName(open, goal)}`);
  const base = nested ? "    " : "  ";
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = (step) => { let d = 0; for (let at = step; at?.parent && d < 4; at = byId.get(at.parent)) d += 1; return d; };
  const onPath = new Set(currentPath(plan).map((s) => s.id));
  const mark = (step) => (onPath.has(step.id) && step.state !== "done" && step.state !== "skipped" ? MARK.current : MARK[step.state] ?? "[ ]");
  let from = 0;
  if (steps.length > 12) {
    const ci = steps.findIndex((s) => s.state === "current");
    const fold = ci === -1 ? steps.length : ci;
    const settled = steps.slice(0, fold).filter((s) => s.state === "done" || s.state === "skipped");
    if (settled.length === fold && fold > 1) {
      const done = settled.filter((s) => s.state === "done").length;
      lines.push(`${base}[x] ${steps[0].id}–${steps[fold - 1].id}: ${done} done, ${fold - done} skipped`);
      from = fold;
    }
  }
  // DOGFOOD #16: steps in plan order; skipped ones fold into one line so the plan reads as it now is.
  const skipped = [];
  for (const step of steps.slice(from)) {
    if (step.state === "skipped") { skipped.push(step); continue; }
    const label = step.label ? ` ${step.label}` : "";
    const tail = step.progress && step.state !== "done" && step.state !== "skipped" ? `   (${step.progress.done}/${step.progress.total})` : "";
    lines.push(`${base}${"  ".repeat(depth(step))}${mark(step)} ${step.id}${label}${tail}`);
    if (step.detail && step.state === "current") lines.push(`${base}${"  ".repeat(depth(step) + 1)}${shorten(step.detail, 100)}`);
  }
  if (skipped.length) lines.push(`${base}${MARK.skipped} ${skipped.length} skipped: ${skipped.map((s) => s.label ? `${s.id} ${s.label}` : s.id).join(", ")}`);
  return lines;
}

/** Inserts `--work <handle>` after `relo work <verb>` in every suggested command (unidentified callers). */
function withHandle(text, handle) {
  if (!handle) return text;
  return text.replace(/relo work (update|pause|resume|finish|deliver)(?! --work)/gu, `relo work $1 --work ${handle}`);
}

/** EDGE.3: a write that did not reach the server yet. */
const QUEUED_LINE = "Queued: sends with the next relo command";

function laneLines(lane, now) {
  const lines = [];
  if (lane?.declared) lines.push(`Queued: ${lane.declared} change${lane.declared === 1 ? "" : "s"} not sent yet${lane.oldestAt ? ` (oldest ${hhmm(lane.oldestAt, now)})` : ""}; they send with the next relo command`);
  for (const item of (lane?.refused ?? []).slice(-3)) lines.push(`Not sent: a queued change was refused by the server (HTTP ${item.status}) at ${hhmm(item.at, now)}; relo state --sync shows what the server has`);
  return lines;
}

/** A refused finish or deliver stays on every echo until an accepted one clears it. */
export function refusedEarlier(refusal, now = new Date()) {
  return `Refused earlier: ${refusal.what} (relo work ${refusal.verb}, ${hhmm(refusal.at, now)}). The card is still open. Next: ${refusal.next ?? `relo work ${refusal.verb} --outcome "…"`}`;
}

export function renderEcho({ work, parked = [], disposition, notes = [], handle, dryRun = false, queued = false, lane, pendingRefusal, now = new Date(), handoffLine, ownerLine, nextOverride, saysLine, notch = false }) {
  const lines = [];
  if (pendingRefusal) lines.push(refusedEarlier(pendingRefusal, now));
  if (dryRun) lines.push("Dry run: nothing was sent.");
  if (!work) {
    lines.push("No open work in this session.");
  } else {
    const lifecycle = work.result && work.result !== "finished" ? "finished" : work.lifecycle ?? "open";
    const disp = work.result && lifecycle === "finished" ? (work.result === "finished" ? "done" : work.result) : disposition;
    lines.push(`Work ${shortId(work.id)} ${q(work.goal)} (${lifecycle}${disp ? `, ${disp}` : ""})`);
    if (handle) lines.push(`Handle: ${handle} (this shell has no session id: pass --work <handle> to every later relo command for this work)`);
    // DOGFOOD #20: a finished work shows its outcome, never the last in-progress status.
    if (work.status && !work.result && !["finished", "failed", "dropped"].includes(lifecycle)) lines.push(`  Status: ${work.status}`);
    if (work.waiting) lines.push(`  Waiting on: ${waitingText(work.waiting)} since ${hhmm(waitingSince(work), now)}`);
    lines.push(...stepLines(work.plan, work.goal));
    if (work.progress && !(work.plan?.steps?.length)) lines.push(`  Progress: ${work.progress.done} of ${work.progress.total}`);
    if (work.outcome) lines.push(`  Outcome: ${work.outcome}`);
  }
  for (const note of notes) lines.push(`Note: ${note}`);
  if (queued) lines.push(QUEUED_LINE);
  lines.push(...laneLines(lane, now));
  if (handoffLine) lines.push(handoffLine);
  if (work) lines.push(ownerLine ? ownerLine : dryRun ? "Owner sees: (not computed in a dry run)" : queued ? "Owner sees: the last change Relo received; this one shows once it is sent" : ownerSees(work, now, disposition, notch));
  // ADR 0015: the line Relo for Mac says for this deliver or finish, so the producer hears what it wrote.
  if (saysLine) lines.push(`Mac says: ${saysLine}`);
  const question = work ? questionLine(work.question, now) : undefined;
  if (question) lines.push(question);
  for (const p of parked.slice(0, 3)) {
    lines.push(`Parked: ${shortId(p.id)} ${q(p.goal)} (${p.pausedReason === "parked" ? "parked" : "paused"}${p.pausedAt ?? p.declaredAt ?? p.lastWriteAt ? ` ${hhmm(p.pausedAt ?? p.declaredAt ?? p.lastWriteAt, now)}` : ""}) → relo work resume ${shortId(p.id)}  |  relo work finish --work ${shortId(p.id)} --outcome "…"`);
  }
  if (parked.length > 3) lines.push(`Parked: and ${parked.length - 3} more (relo state)`);
  lines.push(nextOverride ?? (work ? nextLine(work) : 'Next: relo work start --goal "…" [--plan "A,B,C"]'));
  return withHandle(lines.join("\n"), handle);
}
