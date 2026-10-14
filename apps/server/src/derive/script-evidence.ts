import type { z } from "zod";
import type { scriptEvidenceSchema } from "@relo/notification-contracts";
import type { BoundEvidence,DeclaredWork } from "./clock.js";
import { bindLeaseEvidence } from "./lease-evidence.js";

/** Scripts and apps (an API key, no harness): declared writes plus their lease. No Session row. */
export function bindScriptEvidence(evidence: z.infer<typeof scriptEvidenceSchema>,work: DeclaredWork): BoundEvidence {
  return bindLeaseEvidence(evidence.leaseUntil,work);
}
