import { privateCallbackPolicy } from "../callback-destinations.js";
import { maxQuestionSeconds } from "../question-wait.js";
import type { Handler } from "hono";
import { isServerAdmin,listServerAccounts,registrationMode } from "../server-accounts.js";
import type { Database } from "../db.js";
import {
  parsePresentationPolicy,
  SYSTEM_PRESENTATION_POLICY,
} from "../presentation-policy.js";
import { accountOrRedirect,secureHtml,dashboardDocumentOptions,type DashboardDocumentOptions } from "./http.js";
import type { z } from "zod";
import { accountDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/account";

type SystemDashboardAccount = {
  principalId: string;
  accountId: string;
  user: { id: string; name: string; email: string };
};

type SystemDashboardShell = {
  title: "Account";
  description: string;
  active: "account";
  releaseIdentity: string;
  account: { id: string; initial: string; name: string; email: string };
};

export type AccountDashboardBootstrap = z.input<typeof accountDashboardBootstrapSchema>;

export type SystemDashboardBootstrap = AccountDashboardBootstrap;

type SystemHandlerDependencies = {
  db: Database;
  releaseIdentity: string;
  serverOrigin: string;
  getAccount(headers: Headers): Promise<SystemDashboardAccount | null>;
  renderDocument(bootstrap: SystemDashboardBootstrap,options?: DashboardDocumentOptions): Promise<string>;
};

function shell(
  account: SystemDashboardAccount,
  releaseIdentity: string,
  input: { title: "Account"; active: "account"; description: string },
): SystemDashboardShell {
  return {
    ...input,
    releaseIdentity,
    account: {
      id: account.accountId,
      initial: account.user.name.trim().charAt(0).toUpperCase() || "K",
      name: account.user.name,
      email: account.user.email,
    },
  };
}

export function createDashboardSystemHandlers(
  dependencies: SystemHandlerDependencies,
): { account: Handler } {
  const { db, getAccount, releaseIdentity, renderDocument, serverOrigin } = dependencies;

  const account: Handler = async (context) => {
    const owner = await accountOrRedirect(context, getAccount);
    if (owner instanceof Response) return owner;
    const identity = await db.query<{ provider: string; live_activity_policy: unknown }>(
      `SELECT i.provider,p.live_activity_policy FROM account_identities i
       JOIN owner_principals p ON p.id=i.principal_id
       WHERE i.principal_id=$1 AND i.subject=$2 AND i.provider='better-auth' LIMIT 1`,
      [owner.principalId, owner.user.id],
    );
    if (!identity.rowCount) return context.notFound();
    const storedPolicy = parsePresentationPolicy(identity.rows[0]?.live_activity_policy);
    const users = await db.query<{
      id: string; name: string; email: string; role: "owner" | "member";
      disabled: boolean; sessions: number; devices: number;
    }>(`SELECT u.id,u.name,u.email,i.role,(i.disabled_at IS NOT NULL) AS disabled,
        (SELECT count(*)::int FROM auth.sessions s WHERE s.user_id=u.id AND s.expires_at>now()) AS sessions,
        (SELECT count(*)::int FROM devices d WHERE d.principal_id=i.principal_id
          AND d.registered_by_subject=u.id AND d.revoked_at IS NULL) AS devices
      FROM account_identities i JOIN auth.users u ON u.id=i.subject
      WHERE i.principal_id=$1 ORDER BY (i.role='owner') DESC,u.created_at`,[owner.principalId]);
    const bootstrap: AccountDashboardBootstrap = {
      version: 1,
      kind: "account",
      route: { path: "/dashboard/account" },
      shell: shell(owner, releaseIdentity, {
        title: "Account",
        active: "account",
        description: "Review the owner identity and authentication posture.",
      }) as AccountDashboardBootstrap["shell"],
      account: {
        id: owner.accountId,
        name: owner.user.name,
        email: owner.user.email,
        serverOrigin,
        authentication: "Better Auth email/password session",
        liveActivityPolicy: storedPolicy ?? SYSTEM_PRESENTATION_POLICY,
        liveActivityPolicySource: storedPolicy ? "account" : "system",
      },
      users: users.rows,
      server: await isServerAdmin(db,owner.user.id)
        ? { registrationMode: await registrationMode(db,serverOrigin),maxQuestionSeconds: await maxQuestionSeconds(db),
            privateCallbacks: await privateCallbackPolicy(db),accounts: await listServerAccounts(db) }
        : null,
    };
    return secureHtml(context, await renderDocument(bootstrap,dashboardDocumentOptions(context)));
  };

  return { account };
}
