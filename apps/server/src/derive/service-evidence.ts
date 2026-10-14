import type { z } from "zod";
import type { serviceEvidenceSchema } from "@relo/notification-contracts";
import type { BoundEvidence,DeclaredWork } from "./clock.js";
import { bindLeaseEvidence } from "./lease-evidence.js";

/** Services (`hook_…` secret over HTTP): declared writes plus their lease. No Session row. */
export function bindServiceEvidence(evidence: z.infer<typeof serviceEvidenceSchema>,work: DeclaredWork): BoundEvidence {
  return bindLeaseEvidence(evidence.leaseUntil,work);
}
