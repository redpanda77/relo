import { z } from "zod";

/**
 * The scope registry (plan 10 M2): every scope a Relo credential can hold, what it allows, and which credential
 * kinds may hold it. The server's checks, device authorization, the CLI (a generated copy) and the docs read this
 * list; a scope string anywhere else is a review rejection.
 */
export const CREDENTIAL_KINDS = ["login", "ci-token", "device", "harness", "service"] as const;
export type CredentialKind = typeof CREDENTIAL_KINDS[number];

type ScopeDefinition = { means: string; kinds: readonly CredentialKind[] };

export const SCOPES = {
  "notifications:send": { means: "Send notices to the owner's phones.", kinds: ["login", "ci-token"] },
  "interactions:create": { means: "Ask questions and approvals.", kinds: ["login", "ci-token"] },
  "interactions:read": { means: "Read, wait on and stream the answers to its questions.", kinds: ["login", "ci-token"] },
  "activities:write": { means: "Start, update and finish works and their cards.", kinds: ["login", "ci-token"] },
  "activities:read": { means: "Read works, Now and the sessions list.", kinds: ["login", "ci-token"] },
  "devices:read": { means: "List the account's phones and delivery evidence.", kinds: ["login", "ci-token"] },
  "services:read": { means: "List webhook services and computer credentials.", kinds: ["login", "ci-token"] },
  "services:write": { means: "Create, rotate and revoke webhook services and computer credentials.", kinds: ["login", "ci-token"] },
  "device:self": { means: "A phone manages its own registration, keys and tokens.", kinds: ["device"] },
  "inbox:read": { means: "A phone reads the owner's inbox and current state.", kinds: ["device"] },
  "interactions:respond": { means: "A phone answers questions and approvals.", kinds: ["device"] },
  "presence:write": { means: "Hooks report a session's observed phase, nothing else.", kinds: ["harness"] },
  "hooks:notify": { means: "A service sends notices and questions and manages its own events.", kinds: ["service"] },
  "hooks:cards": { means: "A service starts, updates and ends its own cards.", kinds: ["service"] },
  "hooks:works": { means: "A service starts, updates and finishes its own works.", kinds: ["service"] },
  "hooks:read": { means: "A service reads its own events and answers.", kinds: ["service"] },
} as const satisfies Record<string, ScopeDefinition>;

export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];
export const scopeSchema = z.enum(SCOPE_NAMES as [Scope, ...Scope[]]);

/** The scopes a credential kind may hold, in registry order. */
export function scopesFor(kind: CredentialKind): Scope[] {
  return SCOPE_NAMES.filter((scope) => (SCOPES[scope].kinds as readonly CredentialKind[]).includes(kind));
}

/** The scopes a CLI login may request at sign-in. */
export const LOGIN_SCOPES = scopesFor("login") as [Scope, ...Scope[]];
export const loginScopeSchema = z.enum(LOGIN_SCOPES);
export type LoginScope = z.infer<typeof loginScopeSchema>;

export function isScope(value: string): value is Scope {
  return Object.hasOwn(SCOPES, value);
}
