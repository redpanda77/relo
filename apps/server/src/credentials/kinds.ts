import { FACTS,scopesFor,type CredentialKind,type Scope } from "@relo/notification-contracts";

/**
 * Credential kinds as data (plan 10 M1.2): what each kind is, in one table the modules in this folder read, and
 * kinds.test.ts keeps complete and consistent with the scope registry. Adding a kind is one entry here.
 */
export type DigestName = "plain" | "machine" | "webhook";
export type Rotation = { rotatable: true } | { rotatable: false; instead: string };

export type CredentialKindFacts = {
  /** The table a credential of this kind is stored in. */
  table: "principal_api_keys" | "device_credentials" | "harness_credentials" | "webhook_services";
  /** The prefix of the credential's public id in the API, or null when it has none (a phone is known by its device). */
  idPrefix: "key" | "hck" | "svc" | null;
  /** How a token looks: its lead, the random characters after it, and how many characters lists show. */
  token: { lead: string; randomChars: number; shownChars: number };
  /** The digest the token is stored under (hash.ts). */
  digest: DigestName;
  /** Whether a caller of this kind may send the `Relo-Session-Key` header (an agent's session). */
  sessionHeader: boolean;
  /** `null`: no fixed lifetime from the facts (a login's is chosen at sign-in, a phone's is none). */
  lifetime: { defaultDays: number; maxDays: number } | null;
  /** The scopes it may hold, from the scope registry. */
  scopes: readonly Scope[];
  rotation: Rotation;
};

const MACHINE_TOKEN = { lead: "relo_",randomChars: 43,shownChars: 15 } as const;

export const CREDENTIAL_KIND_TABLE: Record<CredentialKind,CredentialKindFacts> = {
  login: {
    table: "principal_api_keys",idPrefix: "key",token: MACHINE_TOKEN,digest: "machine",sessionHeader: true,
    lifetime: null,scopes: scopesFor("login"),rotation: { rotatable: false,instead: "sign in again" },
  },
  "ci-token": {
    table: "principal_api_keys",idPrefix: "key",token: MACHINE_TOKEN,digest: "machine",sessionHeader: true,
    lifetime: { defaultDays: FACTS.credentials.ciTokenDefaultDays,maxDays: FACTS.credentials.ciTokenMaxDays },
    scopes: scopesFor("ci-token"),rotation: { rotatable: true },
  },
  device: {
    table: "device_credentials",idPrefix: null,token: MACHINE_TOKEN,digest: "plain",sessionHeader: false,
    lifetime: null,scopes: scopesFor("device"),rotation: { rotatable: false,instead: "the phone registers again" },
  },
  harness: {
    table: "harness_credentials",idPrefix: "hck",token: MACHINE_TOKEN,digest: "machine",sessionHeader: false,
    lifetime: null,scopes: scopesFor("harness"),rotation: { rotatable: true },
  },
  service: {
    table: "webhook_services",idPrefix: "svc",token: { lead: "hook_",randomChars: 43,shownChars: 13 },digest: "webhook",sessionHeader: false,
    lifetime: null,scopes: scopesFor("service"),rotation: { rotatable: true },
  },
};

export const kindFacts = (kind: CredentialKind): CredentialKindFacts => CREDENTIAL_KIND_TABLE[kind];
