import type { ActivityActor } from "../activity-commands/types.js";
import type { ComputerIcon } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { effectiveComputerIcon } from "../computers/store.js";
import { loadClientPresentationPolicy,loadServicePresentationPolicy,type EffectivePresentationPolicy } from "../presentation-policy.js";

/**
 * What projecting a work onto its card needs from the producer that holds the work (plan 10 M5): who the
 * activity commands run as, the producer's presentation policy, and the namespace its card identity lives in.
 * The projection itself (card-projection.ts) is the same for every producer type.
 */
export type CardActor = {
  actor: ActivityActor;
  presentationPolicy(): Promise<EffectivePresentationPolicy>;
  /** The icon the producer's cards show for its project token: a login's computer icon; a service has none. */
  computerIcon(): Promise<ComputerIcon | undefined>;
  /** The work-identity namespace (`credential:<id>`, `service:<id>`), as the producer's own card writes use. */
  identityNamespace: string;
};

/** A script's or an agent session's card: the login that holds the work, with that login's presentation policy. */
export function credentialCardActor(db: Database,actor: Extract<ActivityActor,{ kind: "credential" }>): CardActor {
  return {
    actor,
    presentationPolicy: () => loadClientPresentationPolicy(db,actor.principalId,actor.credentialId),
    computerIcon: () => effectiveComputerIcon(db,actor.credentialId),
    identityNamespace: `credential:${actor.credentialId}`,
  };
}

/** A webhook service's card: the service, with its own presentation policy over the account's. */
export function serviceCardActor(db: Database,service: { id: string; principal_id: string; title: string; secret_hash: string; live_activity_policy?: unknown }): CardActor {
  return {
    actor: { kind: "service",principalId: service.principal_id,serviceId: service.id,secretHash: service.secret_hash,sourceName: service.title },
    presentationPolicy: () => loadServicePresentationPolicy(db,service),
    computerIcon: async () => undefined,
    identityNamespace: `service:${service.id}`,
  };
}
