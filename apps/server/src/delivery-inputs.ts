import { z } from "zod";
import type { Database } from "./db.js";
import { DeliveryClaimOwnershipLostError, DeliverySerializationMismatchError } from "./apns-worker-state.js";
import { DeliverySerializationValidationError } from "./delivery-serialization.js";

const inputSchema = z.object({ badge: z.number().int().min(0).max(2_147_483_647),avatarUrl: z.string().max(2_048).nullable() }).strict();
export type OrdinaryDeliveryInputs = z.infer<typeof inputSchema>;

/** Capture changing presentation inputs once; preserve all existing payload hash fences. */
export async function pinOrdinaryDeliveryInputs(
  db: Pick<Database, "query">,
  job: { id: string; claim_token: string; ordinary_delivery_inputs: unknown },
  current: () => Promise<OrdinaryDeliveryInputs>,
): Promise<OrdinaryDeliveryInputs> {
  if (job.ordinary_delivery_inputs != null) return validated(job.ordinary_delivery_inputs);
  const proposed = validated(await current());
  const result = await db.query<{ ordinary_delivery_inputs: unknown }>(
    `UPDATE delivery_jobs SET ordinary_delivery_inputs=COALESCE(ordinary_delivery_inputs,$3::jsonb)
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'
       AND (ordinary_delivery_inputs IS NOT NULL OR (device_projection_sha256 IS NULL AND apns_payload_sha256 IS NULL))
     RETURNING ordinary_delivery_inputs`,
    [job.id,job.claim_token,JSON.stringify(proposed)],
  );
  if (result.rowCount === 1) return validated(result.rows[0]!.ordinary_delivery_inputs);
  const owned = await db.query("SELECT 1 FROM delivery_jobs WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'",[job.id,job.claim_token]);
  if (owned.rowCount !== 1) throw new DeliveryClaimOwnershipLostError();
  throw new DeliverySerializationMismatchError();
}

function validated(input: unknown): OrdinaryDeliveryInputs {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new DeliverySerializationValidationError();
  return parsed.data;
}
