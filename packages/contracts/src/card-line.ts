/**
 * The one Lock Screen line (plan 2.25). Every surface that echoes what the owner sees (CLI echo,
 * Dashboard, iPhone) renders this same string from the same work, held by fixtures/card-line-v1.json.
 *
 * With a plan and a current step: "Step i of n · <label> · d of t" (count only when the current
 * step carries one; "t of t ✓" once it is complete). Skipped steps never count: they are neither
 * done nor open (n counts done, current and open steps).
 * Without a current step the line is the label alone (waiting reason, status or goal),
 * with a work-level count when one exists. Never a plan-wide percent; never a placeholder.
 */
export type CardLineStep = {
  id: string;
  state: "open" | "current" | "done" | "skipped";
  label?: string | undefined;
  progress?: { done: number; total: number } | undefined;
};

export type CardLineWork = {
  goal?: string | undefined;
  status?: string | undefined;
  waiting?: { reason?: string | undefined } | string | null | undefined;
  progress?: { done: number; total: number } | null | undefined;
  plan?: { steps: CardLineStep[] } | null | undefined;
};

const count = (progress: { done: number; total: number }) =>
  `${progress.done} of ${progress.total}${progress.done >= progress.total ? " ✓" : ""}`;

const waitingReason = (waiting: CardLineWork["waiting"]) =>
  (typeof waiting === "string" ? waiting : waiting?.reason) || undefined;

export function cardLine(work: CardLineWork): string {
  const steps = work.plan?.steps ?? [];
  const currentIndex = steps.findIndex((step) => step.state === "current");
  const current = steps[currentIndex];
  if (current) {
    const index = steps.filter((step) => step.state === "done").length + 1;
    const total = steps.filter((step) => step.state !== "skipped").length;
    const parts = [`Step ${index} of ${total}`];
    if (current.label) parts.push(current.label);
    if (current.progress) parts.push(count(current.progress));
    return parts.join(" · ");
  }
  const reason = waitingReason(work.waiting);
  const label = reason ? `Waiting on ${reason}` : (work.status || work.goal || "");
  return work.progress ? [label,count(work.progress)].filter(Boolean).join(" · ") : label;
}

/**
 * What the server stores for a sealed card's text. The iPhone replaces exactly these strings with the
 * text it opens (ReloSealedCards.titlePlaceholder/statusPlaceholder); any other string is shown as is,
 * so every producer path must use these, never its own wording.
 */
export const SEALED_CARD_PLACEHOLDERS = { title: "Encrypted card",status: "Updating…" } as const;
