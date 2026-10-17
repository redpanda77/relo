// The Live Activity card primitives notices, questions and the card commands share: finding the running card,
// the card name option, the wait reply check and the privacy option.
import { ApiError, UsageError } from "../shared/errors.mjs";
import { isIsoTimestamp, optionalText, validateCanonicalId } from "../shared/validate.mjs";
import { deliveryGuard } from "./delivery.mjs";

export const DEFAULT_ACTIVITY_STALE_SECONDS = 1_200;

export function activityName(options,stdin = {}) {
  const candidates = [options.name,stdin.name]
    .filter((value) => value !== undefined);
  if (candidates.length > 1) throw new UsageError("Use only one of --name or stdin name");
  return optionalText(candidates[0],"Activity name",100);
}

export async function activeCard(client, target) {
  try {
    const found = await client.getActivity(target);
    return found?.activity?.state === "active" ? found.activity : null;
  } catch (error) {
    if (error?.status === 404 || error?.code === "NOT_FOUND" || error?.code === "ACTIVITY_NOT_FOUND") return null;
    throw error;
  }
}

export function validateActivityWaitResponse(value, expected) {
  const interaction = value?.interaction;
  const delivery = value?.delivery;
  const validDeliveryMode = value?.deliveryMode === "queued_for_direct_apns"
    || value?.deliveryMode === "durable_inbox_refresh_only";
  const directDelivery = delivery?.apnsJobs > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.parentActivityId !== expected.parentActivityId
    || value.companionActivityId !== null
    || !interaction || typeof interaction !== "object" || Array.isArray(interaction)
    || !validateCanonicalId(interaction.id, "int")
    || !validateCanonicalId(interaction.eventId, "ntf")
    || interaction.eventId !== value.eventId
    || interaction.type !== expected.type
    // A sealed question comes back with the server's placeholder prompt.
    || (expected.prompt !== undefined && interaction.prompt !== expected.prompt)
    || typeof interaction.state !== "string" || interaction.state.length === 0
    || !isIsoTimestamp(interaction.expiresAt)
    || !Number.isInteger(value.queued) || value.queued < 0
    || typeof value.replayed !== "boolean"
    || !validDeliveryMode
    || directDelivery !== (value.deliveryMode === "queued_for_direct_apns")) {
    throw new ApiError("Activity wait response was invalid.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return deliveryGuard({
    parentActivityId: value.parentActivityId,
    companionActivityId: value.companionActivityId,
    interaction: {
      id: interaction.id,
      eventId: interaction.eventId,
      type: interaction.type,
      prompt: interaction.prompt,
      state: interaction.state,
      expiresAt: interaction.expiresAt,
    },
    eventId: value.eventId,
    delivery: {
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
      apnsJobs: delivery.apnsJobs,
    },
    queued: value.queued,
    deliveryMode: value.deliveryMode,
    replayed: value.replayed,
  });
}
