import { OWNER_STATE_TIMING,nowQuerySchema,type NowItem,type NowSummary } from "@relo/notification-contracts";
import type { Hono } from "hono";
import { agentSessionRowsSql } from "../agent-sessions.js";
import { hooklessSessionRows,sessionsViewRows } from "../derive/sessions-view.js";
import { requireScope } from "../auth.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { loadOwnerStateInputs } from "../derive/load.js";
import { buildNowSummary } from "../derive/now-summary.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import type { LoadedWork } from "../derive/load.js";
import { sealedNoticeSchema,type SealedEnvelope } from "../sealed-content.js";
import type { ApiRouteContext } from "./route-context.js";

/**
 * `GET /api/now?since=<ISO>`: the clients' only source of policy. Every item carries its derived
 * owner state; clients display it and refetch at `refreshAt`. Reads only, never writes.
 */
export function registerNowRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;
  app.get("/api/now",requireScope("inbox:read"),async (context) => {
    const auth = context.get("auth");
    const query = nowQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_since" },400);
    context.header("Cache-Control","no-store");
    return context.json(await loadNowSummary(db,auth.principalId,auth.deviceId,query.data.since,
      { ownerOverview: auth.ownerOverview }));
  });
}

/**
 * `deviceId` picks the reader's own envelopes; an `ownerOverview` device (owner-overview.ts) sees the
 * whole account's Now, like the Dashboard, yet still gets only the envelopes it is a recipient of.
 */
export async function loadNowSummary(db: Pick<Database,"query">,principalId: string,deviceId: string | undefined,
  sinceParam: string | undefined,options: { ownerOverview?: boolean | undefined } = {}): Promise<NowSummary> {
  const clock = await db.query<{ now: Date; sessions: any[] }>(
    `SELECT statement_timestamp() AS now,${agentSessionRowsSql("$1::uuid")} AS sessions`,[principalId]);
  const now = clock.rows[0]?.now ?? new Date();
  const sessionRows = clock.rows[0]?.sessions ?? [];
  // The owner's last look on this device, clamped to [now − T_history, now].
  const floor = now.valueOf() - OWNER_STATE_TIMING.historySeconds * 1000;
  const since = new Date(Math.min(now.valueOf(),Math.max(floor,sinceParam ? Date.parse(sinceParam) : floor)));

  const works = await loadOwnerStateInputs(db,principalId,"visible",now,{ deviceId,ownerOverview: options.ownerOverview });
  const sessionIdByKey = new Map<string,string>(sessionRows.map((row) => [row.session_hash,publicId("ags",row.id)]));
  // A card keeps its session's sealed name after the session ends (it leaves the Sessions view, not the card).
  const namesByKey = new Map<string,unknown>(deviceId === undefined ? []
    : sessionRows.filter((row) => row.sealed_names).map((row) => [row.session_hash,row.sealed_names]));
  const items: NowItem[] = works.map((work) => ({
    id: work.id,
    title: work.title,
    status: work.status,
    sourceName: work.sourceName,
    ...(work.computerIcon ? { computerIcon: work.computerIcon } : {}),
    project: work.project,
    steps: work.steps,
    progress: work.planProgress,
    ...(work.planDigest ?? {}),
    producer: work.producer,
    sessionId: work.sessionKey ? sessionIdByKey.get(work.sessionKey) ?? null : null,
    ...(work.sessionKey && namesByKey.has(work.sessionKey) ? { sessionNames: namesByKey.get(work.sessionKey) } : {}),
    notificationId: work.notificationId,
    startedAt: work.startedAt.toISOString(),
    declaredAt: work.declaredAt.toISOString(),
    question: work.question ? { id: work.question.id,standing: work.question.standing,
      askedAt: work.question.askedAt.toISOString(),openedAt: work.question.openedAt?.toISOString() ?? null } : null,
    owner: deriveOwnerState(work.input),
    ...phoneEnvelopes(work,deviceId),
  }));

  const hooked = sessionsViewRows(sessionRows,now,{ withSealedNames: deviceId !== undefined });
  const reported = new Set<string>(sessionRows.map((row) => row.session_hash));
  // A hookless session gets a row only while it has a live work (never show trash).
  const hookless = hooklessSessionRows(works.flatMap((work) => work.producer === "agent_session" && work.sessionKey && work.workOpen
    ? [{ id: work.id.replace(/^act_/,""),sessionKey: work.sessionKey,declaredAt: work.declaredAt,active: work.active,
      source: work.sourceName,project: work.project,computer: work.computer,
      ...(work.computerIcon ? { computerIcon: work.computerIcon } : {}) }] : []),reported,now);
  // Work items name their hookless session row too.
  for (const row of hookless) {
    const key = works.find((work) => work.id === row.id)?.sessionKey;
    for (const item of items) if (item.sessionId === null && key && works.find((work) => work.id === item.id)?.sessionKey === key) item.sessionId = row.id;
  }
  return buildNowSummary({ now,since,items,sessions: [...hooked,...hookless] });
}

/**
 * The phone's envelopes for one Now item (docs/ENCRYPTION-PROTOCOL.md "Phone surfaces"): the card's
 * current content envelope and its pending or missed question's, each only when this phone is a
 * recipient. Phones only; `{}` when neither exists, so the field is absent.
 */
function phoneEnvelopes(work: LoadedWork,deviceId: string | undefined): Pick<NowItem,"sealed"> {
  if (deviceId === undefined || !work.sealed) return {};
  const device = publicId("dev",deviceId);
  const content = (stored: unknown,kind: "card" | "question"): SealedEnvelope | null => {
    const parsed = sealedNoticeSchema.safeParse(stored);
    if (!parsed.success || parsed.data.content.kind !== kind) return null;
    return parsed.data.content.recipients.some((recipient) => recipient.device === device) ? parsed.data.content : null;
  };
  const card = content(work.sealed.card,"card");
  const asking = work.question?.standing === "pending" || work.question?.standing === "missed";
  const question = asking ? content(work.sealed.question,"question") : null;
  return card || question ? { sealed: { card,question } } : {};
}
