import { createHash } from "node:crypto";
import { captureActivityCommand } from "./activity-command-store.mjs";
import { ReloError } from "./errors.mjs";

/** Reuse the protected immutable metadata journal. Non-native commands have no
 * target/sequence; their subject version and policy are part of the intent hash.
 * The namespace prevents a native command key from colliding with this record. */
export async function prepareNotificationCommand({ config,key,body,kind,occurredAt },options) {
  let record;
  try {
    record=await captureActivityCommand({ config,key:`notification:${key}`,operation:kind,
      selector:body.relevance?.subjectKey ?? "independent",body,
      occurredAt:body.relevance?.occurredAt ?? occurredAt,
      resolve:async()=>({target:null,ifSequence:null}),
    },options);
  } catch(error) {
    if(error?.code==="ACTIVITY_CAPTURE_UNAVAILABLE") throw new ReloError(
      "The original notification command could not be preserved. No mutation was sent.",
      {code:"PRODUCER_CAPTURE_UNAVAILABLE"});
    throw error;
  }
  return {...body,relevance:body.relevance ?? {
    subjectKey:`event:${createHash("sha256").update(key).digest("hex")}`,
    generation:1,revision:1,operation:"replace",occurredAt:record.occurredAt,
    policy:kind==="decision"?{kind,actionSeconds:body.expiresInSeconds}:{kind:"notice"},
  }};
}
