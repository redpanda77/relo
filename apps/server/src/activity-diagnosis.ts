import type { ApnsMode } from "./activities.js";
import { safeDiagnosticCode } from "./apns-observability.js";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";

type DiagnosisStage = "server" | "apns" | "phone";
type DiagnosisStatus = "healthy" | "waiting" | "failed" | "unconfirmed";

type DeviceAssessment = {
  status: DiagnosisStatus;
  lastConfirmedStage: DiagnosisStage;
  problemStage: DiagnosisStage | null;
  code: string;
  message: string;
  nextAction: string;
};

export async function loadActivityDiagnosis(
  db: Database,
  principalId: string,
  activityId: string,
  apnsMode: ApnsMode,
) {
  const activity = (await db.query<any>(
    `SELECT id,generation,sequence,state,target_device_ids,created_at,updated_at,ended_at
     FROM live_activities WHERE id=$1 AND principal_id=$2`,
    [activityId,principalId],
  )).rows[0];
  if (!activity) return null;

  const targetDeviceIds = Array.isArray(activity.target_device_ids)
    ? activity.target_device_ids.map(String)
    : [];
  const operation = activityOperation(activity);
  const rows = targetDeviceIds.length === 0 ? [] : (await db.query<any>(
    `SELECT d.id,d.name,d.apns_environment,d.live_activity_authorization,
       (d.live_activity_push_to_start_token IS NOT NULL) AS has_push_to_start_token,
       (t.live_activity_id IS NOT NULL) AS has_update_token,t.updated_at AS token_updated_at,
       j.id AS delivery_job_id,j.notification_event_id,j.state AS delivery_state,
       j.created_at AS job_created_at,j.accepted_at,j.provider_outcome_category,
       j.last_error_code,j.provider_status,j.provider_transport_code,
       e.created_at AS command_created_at,e.payload#>>'{liveActivity,operation}' AS operation,
       receipt.received_at,attempt.provider_reason
     FROM devices d
     LEFT JOIN live_activity_update_tokens t
       ON t.device_id=d.id AND t.live_activity_id=$2 AND t.generation=$5
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM delivery_jobs candidate
       JOIN notification_events candidate_event ON candidate_event.id=candidate.notification_event_id
       WHERE candidate.live_activity_id=$2 AND candidate.device_id=d.id
         AND candidate_event.principal_id=$1
         AND candidate_event.payload#>>'{liveActivity,generation}'=$5::text
         AND candidate_event.payload#>>'{liveActivity,sequence}'=$4::text
       ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
     ) j ON true
     LEFT JOIN notification_events e ON e.id=j.notification_event_id AND e.principal_id=$1
     LEFT JOIN LATERAL (
       SELECT min(i.created_at) AS received_at FROM interactions i
       WHERE i.principal_id=$1 AND i.notification_event_id=j.notification_event_id
         AND i.device_id=d.id AND i.kind='received'
     ) receipt ON true
     LEFT JOIN LATERAL (
       SELECT a.provider_reason FROM delivery_attempts a
       WHERE a.delivery_job_id=j.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1
     ) attempt ON true
     WHERE d.principal_id=$1 AND d.id=ANY($3::uuid[])
     ORDER BY d.name,d.id`,
    [principalId,activityId,targetDeviceIds,Number(activity.sequence),Number(activity.generation)],
  )).rows;

  const devices = rows.map((row: any) => deviceDiagnosis(row,operation,apnsMode));
  const missingTargetCount = Math.max(0,targetDeviceIds.length-devices.length);
  const assessment = summarizeDiagnosis(devices.map((device: any) => device.assessment),{
    targetCount: targetDeviceIds.length,missingTargetCount,apnsMode,
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    activity: {
      id: publicId("act",activity.id),
      generation: Number(activity.generation),
      sequence: Number(activity.sequence),
      state: activity.state,
      operation,
      createdAt: iso(activity.created_at),
      updatedAt: iso(activity.updated_at),
      endedAt: nullableIso(activity.ended_at),
    },
    transport: {
      mode: apnsMode,
      directApnsEnabled: apnsMode !== "disabled",
    },
    targets: {
      expected: targetDeviceIds.length,
      found: devices.length,
      missing: missingTargetCount,
      confirmed: devices.filter((device: any) => device.assessment.status === "healthy").length,
    },
    assessment,
    devices,
  };
}

function activityOperation(activity: any): "start" | "update" | "end" {
  if (Number(activity.sequence) === 0) return "start";
  return activity.state === "ended" ? "end" : "update";
}

function deviceDiagnosis(row: any,operation: "start" | "update" | "end",apnsMode: ApnsMode) {
  const deliveryId = row.delivery_job_id ? publicId("job",row.delivery_job_id) : null;
  const notificationId = row.notification_event_id ? publicId("ntf",row.notification_event_id) : null;
  const activityCreated = Boolean(row.has_update_token) || (operation === "start" && Boolean(row.received_at));
  const commandApplied = Boolean(row.received_at);
  const assessment = assessDevice(row,operation,apnsMode,activityCreated,commandApplied);
  return {
    device: { id: publicId("dev",row.id),name: row.name },
    readiness: {
      liveActivities: row.live_activity_authorization,
      environment: row.apns_environment,
      pushToStartToken: row.has_push_to_start_token ? "present" : "missing",
      updateToken: row.has_update_token ? "present" : "missing",
    },
    server: {
      state: deliveryId ? "command_queued" : "command_not_queued",
      deliveryId,
      notificationId,
      queuedAt: nullableIso(row.job_created_at),
      commandCreatedAt: nullableIso(row.command_created_at),
    },
    apns: {
      state: apnsState(row,apnsMode),
      acceptedAt: nullableIso(row.accepted_at),
      providerStatus: row.provider_status === null || row.provider_status === undefined
        ? null
        : Number(row.provider_status),
      code: safeDiagnosticCode(row.last_error_code)
        ?? safeDiagnosticCode(row.provider_outcome_category)
        ?? safeDiagnosticCode(row.provider_reason)
        ?? safeDiagnosticCode(row.provider_transport_code),
    },
    phone: {
      activityCreated: activityCreated ? "confirmed" : "unconfirmed",
      activityCreatedAt: nullableIso(row.token_updated_at ?? (operation === "start" ? row.received_at : null)),
      latestCommandApplied: commandApplied ? "confirmed" : "unconfirmed",
      latestCommandAppliedAt: nullableIso(row.received_at),
    },
    assessment,
  };
}

function apnsState(row: any,apnsMode: ApnsMode): string {
  if (apnsMode === "disabled") return "disabled";
  if (!row.delivery_job_id) return "not_queued";
  if (row.provider_outcome_category === "invalid-recipient" || row.delivery_state === "token_invalid") {
    return "token_invalid";
  }
  return ({
    pending: "queued",
    processing: "sending",
    accepted: "accepted",
    retry: "retrying",
    permanently_failed: "rejected",
    reconciliation_required: "ambiguous",
    canceled: "canceled",
  } as Record<string,string>)[String(row.delivery_state)] ?? "unknown";
}

function assessDevice(
  row: any,
  operation: "start" | "update" | "end",
  apnsMode: ApnsMode,
  activityCreated: boolean,
  commandApplied: boolean,
): DeviceAssessment {
  if (row.live_activity_authorization !== "authorized") {
    return assessment("failed","server","phone","LIVE_ACTIVITIES_NOT_AUTHORIZED",
      "The phone is registered, but Live Activities are not authorized.",
      "Enable Live Activities for Relo in iPhone Settings, open Relo once, then start the activity again.");
  }
  if (!row.delivery_job_id) {
    if (apnsMode === "disabled") {
      return assessment("failed","server","server","DIRECT_APNS_DISABLED",
        "The server committed the activity, but direct APNs delivery is disabled.",
        "Configure the server APNs runtime, run `relo doctor --json`, then retry the activity command.");
    }
    if (row.apns_environment !== apnsMode) {
      return assessment("failed","server","server","APNS_ENVIRONMENT_MISMATCH",
        "The phone registration and server APNs environments do not match.",
        "Reinstall the matching development or production iOS build, open Relo, and re-register the phone.");
    }
    if (operation === "start" && !row.has_push_to_start_token) {
      return assessment("failed","server","phone","PUSH_TO_START_TOKEN_MISSING",
        "The server has no push-to-start token for this phone, so it could not enqueue the activity start.",
        "Open Relo with Live Activities enabled so it can refresh registration, then retry the start.");
    }
    if (operation !== "start" && !row.has_update_token) {
      return assessment("failed","server","phone","UPDATE_TOKEN_MISSING",
        "The server has no current-generation update token for this activity on the phone.",
        "Run `relo activity diagnose` on the start command; if creation is unconfirmed, start a fresh activity.");
    }
    return assessment("failed","server","server","COMMAND_NOT_QUEUED",
      "The canonical activity command exists, but no delivery job was created for this phone.",
      "Run `relo doctor --json` and inspect server logs for activity command creation before retrying.");
  }

  const state = apnsState(row,apnsMode);
  if (state === "token_invalid") {
    return assessment("failed","server","apns","APNS_TOKEN_INVALID",
      "APNs rejected the registered recipient token.",
      "Open Relo to refresh device registration, then start a fresh activity.");
  }
  if (state === "rejected" || state === "canceled") {
    const code = safeDiagnosticCode(row.last_error_code)
      ?? safeDiagnosticCode(row.provider_outcome_category)
      ?? "APNS_REJECTED";
    return assessment("failed","server","apns",code,
      "The server queued the command, but APNs did not accept it.",
      "Use the safe APNs code above with server logs, correct the provider or token issue, then retry.");
  }
  if (state === "ambiguous") {
    return assessment("unconfirmed","server","apns","APNS_OUTCOME_AMBIGUOUS",
      "The APNs request crossed the dispatch boundary without a trustworthy outcome.",
      "Reconcile the delivery job before retrying so the command is not delivered twice.");
  }
  if (state === "queued" || state === "sending" || state === "retrying") {
    return assessment("waiting","server","apns","AWAITING_APNS",
      "The command is durable on the server and is still awaiting a final APNs outcome.",
      "Wait briefly and rerun with `--wait 30s`; inspect the worker if this state does not advance.");
  }
  if (state !== "accepted") {
    return assessment("unconfirmed","server","apns","APNS_STATE_UNKNOWN",
      "The command is queued, but its APNs outcome cannot be classified.",
      "Inspect the delivery job and worker logs before retrying.");
  }

  if (operation === "start" && activityCreated) {
    return assessment("healthy","phone",null,"PHONE_ACTIVITY_CREATED",
      "The server committed the start, APNs accepted it, and the phone created the Live Activity.",
      "No action is required.");
  }
  if (commandApplied) {
    return assessment("healthy","phone",null,"PHONE_COMMAND_APPLIED",
      "The server committed the command, APNs accepted it, and the phone reported applying it.",
      "No action is required.");
  }
  return assessment("unconfirmed","apns","phone",
    operation === "start" ? "PHONE_CREATION_UNCONFIRMED" : "PHONE_APPLICATION_UNCONFIRMED",
    operation === "start"
      ? "APNs accepted the start, but the server has no proof that the phone created the Live Activity."
      : "APNs accepted the command, but the phone has not reported applying this exact event.",
    "Keep Relo installed and registered, verify Live Activities are enabled, then rerun with `--wait 30s`.");
}

function assessment(
  status: DiagnosisStatus,
  lastConfirmedStage: DiagnosisStage,
  problemStage: DiagnosisStage | null,
  code: string,
  message: string,
  nextAction: string,
): DeviceAssessment {
  return { status,lastConfirmedStage,problemStage,code,message,nextAction };
}

function summarizeDiagnosis(
  assessments: DeviceAssessment[],
  input: { targetCount: number; missingTargetCount: number; apnsMode: ApnsMode },
): DeviceAssessment {
  if (input.targetCount === 0) {
    return assessment("failed","server","server","NO_TARGET_DEVICES",
      "The activity has no target phones.",
      "Register a phone with `relo doctor --json`, then start a fresh activity.");
  }
  if (input.missingTargetCount > 0) {
    return assessment("failed","server","server","TARGET_DEVICE_MISSING",
      "One or more target phone registrations no longer exist.",
      "Open Relo to register the phone again, then start a fresh activity.");
  }
  const rank: Record<DiagnosisStatus,number> = { healthy: 0,waiting: 1,unconfirmed: 2,failed: 3 };
  return assessments.reduce((worst,current) => rank[current.status] > rank[worst.status] ? current : worst);
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
