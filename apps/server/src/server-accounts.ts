import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { ApnsMode } from "./activities.js";
import { hashToken } from "./auth.js";
import type { Database } from "./db.js";
import { lockDecisionGroup,settleDecisionGroup } from "./interactions/commands.js";
import { createQuestionCardInTransaction } from "./interactions/question-card.js";
import { prepareNotificationContent, type NotificationContentCipher } from "./notification-content.js";
import { createNotificationInTransaction } from "./notifications/commands.js";
import { createWebhookService } from "./services.js";
import { requireWorkIdentity } from "./work-identity.js";

/** ADR 0004: who may register, and what the server admin can do to an account (never to its data). */
export const registrationModes = ["closed","approval","open"] as const;
export type RegistrationMode = typeof registrationModes[number];
export const accountAccessActions = ["approve","disable","enable","sign-out"] as const;
export type AccountAccessAction = typeof accountAccessActions[number];

type Queryable = { query: Database["query"] };

/**
 * A pending CLI login belongs to nobody until someone approves it, and its code lets the viewer
 * approve it into their own account. Only a one-account installation may list them.
 */
export const unclaimedLoginsVisible = "(SELECT count(*) FROM account_identities WHERE role='owner')<=1";

export type ServerAccount = {
  id: string; name: string; email: string; status: "active" | "pending" | "disabled";
  admin: boolean; createdAt: string; devices: number; sessions: number;
};

export async function registrationMode(db: Queryable): Promise<RegistrationMode> {
  const result = await db.query<{ registration_mode: RegistrationMode }>(
    "SELECT registration_mode FROM server_settings WHERE singleton");
  return result.rows[0]?.registration_mode ?? "closed";
}

export async function setRegistrationMode(db: Database, mode: RegistrationMode): Promise<void> {
  await db.query("UPDATE server_settings SET registration_mode=$1,updated_at=now() WHERE singleton",
    [z.enum(registrationModes).parse(mode)]);
}

export async function isServerAdmin(db: Queryable, subject: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM account_identities
     WHERE subject=$1 AND server_admin AND disabled_at IS NULL AND approved_at IS NOT NULL`,[subject]);
  return Boolean(result.rowCount);
}

/** Why an identity that signed in correctly still may not use the server, or null when it may. */
export async function signInRefusal(db: Queryable, subject: string): Promise<"approval_pending" | "account_disabled" | null> {
  const result = await db.query<{ approved: boolean; disabled: boolean }>(
    `SELECT i.approved_at IS NOT NULL AS approved,
       (i.disabled_at IS NOT NULL OR p.disabled_at IS NOT NULL) AS disabled
     FROM account_identities i JOIN owner_principals p ON p.id=i.principal_id
     WHERE i.provider='better-auth' AND i.subject=$1`,[subject]);
  const row = result.rows[0];
  if (!row || row.disabled) return "account_disabled";
  return row.approved ? null : "approval_pending";
}

/** A new person gets an empty account of their own. */
export async function createAccountPrincipal(
  client: Queryable, subject: string, options: { approved: boolean; serverAdmin?: boolean },
): Promise<string> {
  const principal = await client.query<{ id: string }>(
    "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[`account-${randomUUID()}`]);
  const principalId = principal.rows[0]!.id;
  await client.query(
    `INSERT INTO account_identities(principal_id,provider,subject,role,server_admin,approved_at)
     VALUES ($1,'better-auth',$2,'owner',$3,CASE WHEN $4 THEN now() END)`,
    [principalId,subject,options.serverAdmin ?? false,options.approved]);
  return principalId;
}

export async function createServerAccount(db: Database, input: { name: string; email: string; password: string }): Promise<{ id: string }> {
  const value = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320).transform(email => email.toLowerCase()),
    password: z.string().min(8).max(128),
  }).parse(input);
  const id = randomUUID();
  const password = await hashPassword(value.password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const taken = await client.query("SELECT 1 FROM auth.users WHERE lower(email)=$1",[value.email]);
    if (taken.rowCount) throw new ServerAccountError(409,"email_taken");
    await client.query("INSERT INTO auth.users(id,name,email) VALUES ($1,$2,$3)",[id,value.name,value.email]);
    await client.query(
      `INSERT INTO auth.accounts(id,account_id,provider_id,user_id,password)
       VALUES ($1,$2,'credential',$3,$4)`,[randomUUID(),randomUUID(),id,password]);
    await createAccountPrincipal(client,id,{ approved: true });
    await client.query("COMMIT");
    return { id };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class ServerAccountError extends Error {
  constructor(readonly status: 403 | 404 | 409, readonly code: string) { super(code); }
}

export async function listServerAccounts(db: Queryable): Promise<ServerAccount[]> {
  const result = await db.query<any>(
    `SELECT i.subject,u.name,u.email,i.server_admin,i.approved_at,
       (i.disabled_at IS NOT NULL OR p.disabled_at IS NOT NULL) AS disabled,i.created_at,
       (SELECT count(*)::int FROM devices d WHERE d.principal_id=i.principal_id AND d.revoked_at IS NULL) AS devices,
       (SELECT count(*)::int FROM auth.sessions s WHERE s.user_id=i.subject AND s.expires_at>now()) AS sessions
     FROM account_identities i
     JOIN owner_principals p ON p.id=i.principal_id
     JOIN auth.users u ON u.id=i.subject
     WHERE i.provider='better-auth' AND i.role='owner'
     ORDER BY i.server_admin DESC,i.created_at,i.id`);
  return result.rows.map((row: any) => ({
    id: row.subject,name: row.name,email: row.email,admin: row.server_admin,
    status: row.disabled ? "disabled" : row.approved_at ? "active" : "pending",
    createdAt: new Date(row.created_at).toISOString(),devices: row.devices,sessions: row.sessions,
  }));
}

/** Changes an account's access. Its devices, cards and content are never read or changed. */
export async function changeAccountAccess(
  db: Database, adminSubject: string, subject: string, action: AccountAccessAction, apnsMode: ApnsMode,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (action === "approve" || action === "disable") {
      await settleAccountRequest(client,subject,action === "approve" ? "approved" : "denied",apnsMode);
    }
    const target = await client.query<{ principal_id: string; server_admin: boolean }>(
      `SELECT principal_id,server_admin FROM account_identities
       WHERE provider='better-auth' AND subject=$1 AND role='owner' FOR UPDATE`,[subject]);
    if (!target.rowCount) throw new ServerAccountError(404,"account_not_found");
    const { principal_id: principalId,server_admin: targetIsAdmin } = target.rows[0]!;
    if ((targetIsAdmin || subject === adminSubject) && action !== "sign-out") {
      throw new ServerAccountError(409,"cannot_change_admin_access");
    }
    if (action === "approve") {
      await client.query("UPDATE account_identities SET approved_at=coalesce(approved_at,now()) WHERE subject=$1",[subject]);
    } else if (action === "enable") {
      await client.query("UPDATE account_identities SET disabled_at=NULL WHERE subject=$1",[subject]);
      await client.query("UPDATE owner_principals SET disabled_at=NULL WHERE id=$1",[principalId]);
    } else if (action === "disable") {
      // A disabled principal fails every CLI, service and phone credential check; sessions end now.
      await client.query("UPDATE account_identities SET disabled_at=now() WHERE principal_id=$1 AND disabled_at IS NULL",[principalId]);
      await client.query("UPDATE owner_principals SET disabled_at=now() WHERE id=$1",[principalId]);
    }
    if (action === "disable" || action === "sign-out") {
      await client.query(
        `DELETE FROM auth.sessions WHERE user_id IN (SELECT subject FROM account_identities WHERE principal_id=$1)`,
        [principalId]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/**
 * An account request waits for the admin far longer than an agent's question: the person is not
 * watching a terminal. Unanswered, the approval expires; the Dashboard keeps the request pending.
 */
export const ACCOUNT_REQUEST_SECONDS = 30*24*60*60;

/** The built-in service on the admin's account that sends account requests, like any integration. */
async function accountRequestService(db: Database, adminPrincipalId: string, appUrl: string): Promise<string> {
  const existing = () => db.query<{ id: string }>(
    `SELECT id FROM webhook_services
     WHERE principal_id=$1 AND system_purpose='account_requests' AND revoked_at IS NULL`,[adminPrincipalId]);
  const found = await existing();
  if (found.rowCount) return found.rows[0]!.id;
  // Nobody holds this service's webhook secret; only the server sends as it.
  const created = await createWebhookService(db,adminPrincipalId,"Relo accounts",appUrl);
  try {
    await db.query("UPDATE webhook_services SET system_purpose='account_requests' WHERE id=$1",[created.row.id]);
    return created.row.id;
  } catch {
    // A concurrent request created it first; keep that one.
    await db.query("DELETE FROM webhook_services WHERE id=$1",[created.row.id]);
    return (await existing()).rows[0]!.id;
  }
}

/** A card can stay on the Lock Screen at most 8 hours; the notification keeps waiting after it ends. */
export const ACCOUNT_REQUEST_CARD_SECONDS = 8*60*60;

/**
 * Asks the server admin to let a newly registered person in, as one Relo decision shown twice: a
 * notification approval that waits, and a question card when a phone can show one. Answering
 * either one decides; the other stops asking.
 */
export async function requestAccountApproval(
  db: Database,
  person: { subject: string; name: string; email: string },
  dependencies: { apnsMode: ApnsMode; contentCipher: NotificationContentCipher; appUrl: string },
): Promise<{ decisionGroupId: string; card: boolean } | null> {
  const admin = await db.query<{ principal_id: string }>(
    "SELECT principal_id FROM account_identities WHERE server_admin AND disabled_at IS NULL");
  if (!admin.rowCount) return null;
  const principalId = admin.rows[0]!.principal_id;
  const serviceId = await accountRequestService(db,principalId,dependencies.appUrl);
  const identity = requireWorkIdentity(`service:${serviceId}`,
    { producerKind: "webhook",project: "Relo server",threadName: "Account requests" },undefined);
  if (!identity.ok) throw new Error("account_request_identity_invalid");
  const decisionGroupId = randomUUID();
  // The question is one card line; the full name and email are in the notification body.
  const shownName = Array.from(person.name).length > 40 ? `${Array.from(person.name).slice(0,39).join("").trimEnd()}…` : person.name;
  const prompt = `Let ${shownName} join?`;
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    // The card asks first and alerts; the notification then waits quietly in Relo. Without a phone
    // that shows cards (Live Activities off) the notification alone asks, with an alert.
    await tx.query("SAVEPOINT account_request_card");
    const card = await createQuestionCardInTransaction(tx,{
      principalId,sourceId: `service:${serviceId}`,credentialId: null,serviceId,
    },{ type: "approval",title: "New account request",prompt,expiresInSeconds: ACCOUNT_REQUEST_CARD_SECONDS,
      context: identity.context },{
      idempotencyKey: `account-request-card:${person.subject}`,
      requestHash: hashToken(`account-request-card:${person.subject}`),
      sourceName: "Relo accounts",originHash: null,requestedDeviceIds: null,
      apnsMode: dependencies.apnsMode,deliveryApnsMode: dependencies.apnsMode,
    });
    if (card.kind !== "created") await tx.query("ROLLBACK TO SAVEPOINT account_request_card");
    const notification = await createNotificationInTransaction(tx,{ kind: "service",principalId,serviceId },{
      idempotencyKey: `account-request:${person.subject}`,requestHash: hashToken(`account-request:${person.subject}`),
      sourceName: "Relo accounts",title: "New account request",
      content: prepareNotificationContent({ body: `${person.name} (${person.email}) wants to join this Relo server.` }),
      imageUrl: null,deepLink: null,payload: { privacy: "standard",context: identity.context },
      deviceIds: null,originHash: null,quiet: card.kind === "created",
      interaction: { kind: "approval",prompt,actionSeconds: ACCOUNT_REQUEST_SECONDS },
    },{ apnsMode: dependencies.apnsMode,contentCipher: dependencies.contentCipher });
    if (notification.kind !== "created" || !notification.interaction) {
      await tx.query("ROLLBACK");
      return null;
    }
    const members = [notification.interaction.id,...(card.kind === "created" ? [card.interactionRequestId] : [])];
    await tx.query("UPDATE interaction_requests SET decision_group_id=$1 WHERE id=ANY($2::uuid[])",[decisionGroupId,members]);
    await tx.query(
      `INSERT INTO account_requests(subject,decision_group_id) VALUES ($1,$2)
       ON CONFLICT (subject) DO UPDATE SET decision_group_id=EXCLUDED.decision_group_id`,
      [person.subject,decisionGroupId]);
    await tx.query("COMMIT");
    return { decisionGroupId,card: card.kind === "created" };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

/**
 * The admin decided in the Dashboard: the request's notification and card take that decision and
 * stop asking ("canceled" when the request is removed undecided). Call first
 * in the transaction: like an answer from the phone, it takes the decision group's lock before any
 * decision or account lock, so the two cannot deadlock.
 */
export async function settleAccountRequest(
  tx: Queryable, subject: string, decision: "approved" | "denied" | "canceled", apnsMode: ApnsMode,
): Promise<void> {
  const request = await tx.query<{ decision_group_id: string }>(
    "SELECT decision_group_id FROM account_requests WHERE subject=$1",[subject]);
  const groupId = request.rows[0]?.decision_group_id;
  if (!groupId) return;
  await lockDecisionGroup(tx as any,groupId);
  await settleDecisionGroup(tx as any,{ groupId,apnsMode,
    outcome: { state: decision,response: decision === "canceled" ? null : { decidedIn: "dashboard" } } });
}
