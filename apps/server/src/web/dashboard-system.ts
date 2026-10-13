import { privateCallbackPolicy } from "../callback-destinations.js";
import { maxQuestionSeconds } from "../question-wait.js";
import type { Handler } from "hono";
import { isServerAdmin,listServerAccounts,registrationMode } from "../server-accounts.js";
import type { Database } from "../db.js";
import {
  parsePresentationPolicy,
  SYSTEM_PRESENTATION_POLICY,
} from "../presentation-policy.js";
import { accountOrRedirect,secureHtml } from "./http.js";
import type { z } from "zod";
import { accountDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/account";
import { documentationDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/docs";

type SystemDashboardAccount = {
  principalId: string;
  accountId: string;
  user: { id: string; name: string; email: string };
};

type SystemDashboardShell = {
  title: "Account" | "Documentation";
  description: string;
  active: "account" | "docs";
  releaseIdentity: string;
  account: { id: string; initial: string; name: string; email: string };
};

export type AccountDashboardBootstrap = z.input<typeof accountDashboardBootstrapSchema>;

export type DocumentationLink = { label: string; href: string };

export type DocumentationSection = {
  title: string;
  body: string;
  links: DocumentationLink[];
};

export type DocumentationDashboardBootstrap = z.input<typeof documentationDashboardBootstrapSchema>;

export type SystemDashboardBootstrap =
  | AccountDashboardBootstrap
  | DocumentationDashboardBootstrap;

type SystemHandlerDependencies = {
  db: Database;
  releaseIdentity: string;
  serverOrigin: string;
  getAccount(headers: Headers): Promise<SystemDashboardAccount | null>;
  renderDocument(bootstrap: SystemDashboardBootstrap): Promise<string>;
};

const documentationSections: DocumentationSection[] = [
  {
    title: "Send notifications",
    body: "Create a named service, copy its secret webhook URL without rendering it, and POST a JSON body. Ordinary notifications support a public HTTPS image, a validated HTTPS destination, explicit device targeting, and approval, yes/no, or text responses.",
    links: [
      { label: "Manage services", href: "/dashboard/connections" },
      { label: "Review history", href: "/dashboard/inbox/notifications" },
    ],
  },
  {
    title: "Authorize agents and the CLI",
    body: "A client requests narrowly scoped access. An owner must explicitly approve it; every other outcome denies access. Credentials are shown once and can be revoked from the dashboard.",
    links: [
      { label: "Connect the CLI", href: "/dashboard/account#connect-cli" },
      { label: "Review approvals", href: "/dashboard" },
      { label: "Manage clients", href: "/dashboard/connections" },
    ],
  },
  {
    title: "Coordinate Live Activities",
    body: "Set production appearance at the account level, optionally override it for one CLI client or webhook service, and let the server resolve omitted presentation fields. Test Lab presets remain isolated experiments rather than production defaults.",
    links: [
      { label: "Manage account defaults",href: "/dashboard/account" },
      { label: "Open the Test Lab",href: "/dashboard/testing" },
    ],
  },
  {
    title: "Operate safely",
    body: "Use delivery history for target-level APNs status and keep notification content concise enough for phone surfaces.",
    links: [
      { label: "Inspect delivery", href: "/dashboard/inbox/delivery" },
      { label: "Inspect phones", href: "/dashboard/connections" },
    ],
  },
];

const machineLinks: DocumentationLink[] = [
  { label: "/docs.md", href: "/docs.md" },
  { label: "/agents.md", href: "/agents.md" },
  { label: "/llms.txt", href: "/llms.txt" },
];

function shell(
  account: SystemDashboardAccount,
  releaseIdentity: string,
  input:
    | { title: "Account"; active: "account"; description: string }
    | { title: "Documentation"; active: "docs"; description: string },
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
): { account: Handler; docs: Handler } {
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
        ? { registrationMode: await registrationMode(db),maxQuestionSeconds: await maxQuestionSeconds(db),
            privateCallbacks: await privateCallbackPolicy(db),accounts: await listServerAccounts(db) }
        : null,
    };
    return secureHtml(context, await renderDocument(bootstrap));
  };

  const docs: Handler = async (context) => {
    const owner = await accountOrRedirect(context, getAccount);
    if (owner instanceof Response) return owner;
    const bootstrap: DocumentationDashboardBootstrap = {
      version: 1,
      kind: "docs",
      route: { path: "/dashboard/docs" },
      shell: shell(owner, releaseIdentity, {
        title: "Documentation",
        active: "docs",
        description:
          "Practical entry points for dashboard, CLI, service, and lifecycle workflows.",
      }) as DocumentationDashboardBootstrap["shell"],
      introduction:
        "Relo is a coordinated notification workflow: delivery, persistent history, phone interaction, and result retrieval are one lifecycle.",
      sections: documentationSections.map((section) => ({
        ...section,
        links: section.links.map((link) => ({ ...link })),
      })),
      machineLinks: machineLinks.map((link) => ({ ...link })),
    };
    return secureHtml(context, await renderDocument(bootstrap));
  };

  return { account, docs };
}
