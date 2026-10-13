import { UsageError } from "./errors.mjs";

function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new UsageError(`${label} has unsupported fields or is not an object`);
  }
}

/** Pass explicit producer time through unchanged; retries must never substitute CLI time. */
export function notificationRelevance(value, kind, actionSeconds) {
  if (value === undefined) return undefined;
  object(value,["subjectKey","generation","revision","operation","occurredAt","policy","status"],"relevance");
  if (typeof value.subjectKey !== "string" || !value.subjectKey.trim() || value.subjectKey.length > 200
    || ![value.generation,value.revision].every((version) => Number.isSafeInteger(version) && version > 0)
    || !["update","replace"].includes(value.operation)
    || typeof value.occurredAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt))) {
    throw new UsageError("relevance requires a subject, positive safe versions, operation, and original ISO occurrence time");
  }
  const policyKind=value.policy?.kind;
  const fields={notice:["relevanceSeconds"],decision:["actionSeconds"],progress:["heartbeat"],incident:["mode","leaseUntil"]};
  if (!(kind === "decision" ? policyKind === "decision" : ["notice","progress","incident"].includes(policyKind))) {
    throw new UsageError(`relevance policy does not match this ${kind} command`);
  }
  object(value.policy,["kind","deliverySeconds",...fields[policyKind]],"relevance.policy");
  for(const field of ["deliverySeconds","relevanceSeconds","actionSeconds"]){
    const duration=value.policy[field];
    if(duration!==undefined && (!Number.isSafeInteger(duration)||duration<=0))throw new UsageError("relevance durations must be positive safe integers");
  }
  if(value.status!==undefined && (value.status!=="resolved" || policyKind!=="incident"))throw new UsageError("Only incident relevance can have resolved status");
  const validTime=time=>typeof time==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) && Number.isFinite(Date.parse(time));
  if(policyKind==="progress" && value.policy.heartbeat!==undefined){
    const heartbeat=value.policy.heartbeat;object(heartbeat,["intervalSeconds","lastHeartbeatAt"],"relevance.policy.heartbeat");
    if(!Number.isSafeInteger(heartbeat.intervalSeconds)||heartbeat.intervalSeconds<=0||!validTime(heartbeat.lastHeartbeatAt))throw new UsageError("relevance heartbeat requires a positive interval and original ISO time");
  }
  if(policyKind==="incident" && (!["lease","until_resolved"].includes(value.policy.mode)
    || (value.policy.mode==="lease" ? !validTime(value.policy.leaseUntil) : value.policy.leaseUntil!==undefined))){
    throw new UsageError("relevance incident requires until_resolved or a lease with original ISO leaseUntil");
  }
  if (policyKind === "decision" && value.policy.actionSeconds !== undefined
    && value.policy.actionSeconds !== actionSeconds) {
    throw new UsageError("relevance actionSeconds must equal expires-in");
  }
  const lifetime = policyKind === "notice" ? value.policy.relevanceSeconds ?? 900 : policyKind === "decision" ? actionSeconds : undefined;
  if (lifetime !== undefined && value.policy.deliverySeconds !== undefined && value.policy.deliverySeconds > lifetime) {
    throw new UsageError("relevance delivery window cannot outlive usefulness");
  }
  return { ...value,subjectKey: value.subjectKey.trim(),policy: { ...value.policy } };
}
