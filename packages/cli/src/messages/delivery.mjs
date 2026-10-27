// The server's delivery summary on a notice or question: refused when malformed, NoDeliveryError when nothing will
// show it: no phone got it and no Relo for Mac reads it (`readers`, an account whose only device is the Mac).
import { ApiError, NoDeliveryError } from "../shared/errors.mjs";

export function deliveryGuard(payload) {
  const delivery = payload?.delivery ?? payload;
  if (
    !delivery ||
    !Number.isInteger(delivery.eligibleDevices) ||
    delivery.eligibleDevices < 0 ||
    !Number.isInteger(delivery.durableCommands) ||
    delivery.durableCommands < 0 ||
    !Number.isInteger(delivery.apnsJobs) ||
    delivery.apnsJobs < 0
  ) {
    throw new ApiError("Mutation response did not include a valid delivery summary.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const readers = Number.isInteger(delivery.readers) && delivery.readers > 0 ? delivery.readers : 0;
  if (delivery.durableCommands === 0 && readers === 0) {
    throw new NoDeliveryError(undefined, {
      eventId: payload?.event?.id ?? payload?.eventId ?? payload?.id,
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
    });
  }
  return payload;
}
