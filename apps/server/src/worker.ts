import { writeFile } from "node:fs/promises";
import { requiredReceiptServerOriginHash } from "./receipt-scope.js";
import { setTimeout as delay } from "node:timers/promises";
import { NodeHttp2ApnsTransport } from "./apns-http2-transport.js";
import {
  apnsOperationalLog,
  emptyApnsWorkerCycle,
  observeApnsRuntimeResult,
} from "./apns-observability.js";
import { assertPreparedApnsCutover } from "./apns-operations.js";
import { PostgresApnsRecipientResolver } from "./apns-recipient-resolver.js";
import {
  apnsPriorityForJob,
  ApnsOutcomePersistenceError,
  CleanroomApnsRuntime,
  type ApnsRuntimeJob,
  type ApnsRuntimeResult,
} from "./apns-runtime.js";
import {
  cleanroomProviderConfig,
  readProtectedApnsPrivateKey,
  validateApnsWorkerConfig,
} from "./apns-runtime-config.js";
import {
  DeliveryClaimOwnershipLostError,
  DeliverySerializationMismatchError,
  cancelUnavailableDeliveryClaim,
  claimDeliveryJobs,
  deferMissingActivityToken,
  finalizeDeliveryClaim,
  markDeliveryDispatchStarted,
  markDeliveryClaimForReconciliation,
  pinDeliverySerializationEvidence,
  quarantineDeliverySerializationMismatch,
  quarantineInvalidDeliverySerialization,
  quarantineAbandonedProcessingClaims,
  retryPreparingDeliveryClaim,
  withJobLeaseHeartbeat,
  type ClaimedDeliveryJob,
} from "./apns-worker-state.js";
import {
  deliverySerializationEvidence,
  DeliverySerializationValidationError,
} from "./delivery-serialization.js";
import { pendingInteractionBadgeCount } from "./badge.js";
import { loadAccountAuthSecret, loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { DeliveryJobWakeup } from "./delivery-wakeup.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { nextDeliveryWakeDelay } from "./delivery-scheduling.js";
import { nextInteractionExpiryDelay } from "./interaction-expiry-scheduling.js";
import { pinOrdinaryDeliveryInputs } from "./delivery-inputs.js";
import { prepareLatestActivityFrame } from "./activity-delivery-frame.js";
import { publicId } from "./ids.js";
import { eventConversationId } from "./communication.js";
import { cleanupTerminalDeviceAuthorizations } from "./device-authorization.js";
import { expireDueActivities } from "./activities.js";
import { reconcileAgentSessions } from "./agent-sessions.js";
import { projectLiveActivityCommand } from "./live-activity-interaction.js";
import { expireDueInteractiveActivities } from "./interactive-activity-lifecycle.js";
import {
  cancelUndeliverableDeliveryJobs,
  shouldRetryMissingActivityToken,
} from "./delivery-lifecycle.js";
import {
  createTransportTokenEncryption,
  verifyCurrentTransportTokenEnvelopes,
} from "./token-encryption.js";
import { recordWorkerHeartbeat } from "./runtime-health.js";
import { dispatchDueInteractionCallbacks } from "./interaction-callbacks.js";
import { notifyUnseenQuestionCards } from "./activity-commands/question-fallback.js";
import { createNotificationContentCipher } from "./notification-content.js";
import { runScheduledContentRetention } from "./notification-retention.js";
import { purgeAllUnreadableContent } from "./unreadable-content.js";
import { requestAllPendingApprovals } from "./device-approvals.js";

function projectLiveActivityInteraction(
  job: ClaimedDeliveryJob,
  command: Record<string,unknown>,
  secret: string,
): Record<string,unknown> {
  const projected = {
    ...command,
    targetDeviceId: publicId("dev",job.device_id),
    alertOwner: job.transport === "live_activity_start" ? "apns" : command.alertOwner,
  };
  if (!job.interaction_id || !job.interaction_expires_at
    || (job.interaction_kind !== "approval" && job.interaction_kind !== "yes_no" && job.interaction_kind !== "choice")) return projected;
  return projectLiveActivityCommand(secret,{
    interactionId: job.interaction_id, notificationEventId: job.event_id,
    deviceId: job.device_id,principalId: job.principal_id,
    credentialVersion: Number(job.credential_version),
    expiresAt: new Date(job.interaction_expires_at), interactionKind: job.interaction_kind,
    interactionState: job.interaction_state ?? "pending",
  },projected);
}

const config = loadConfig();
const configuredReceiptOriginHash = requiredReceiptServerOriginHash(process.env.APP_URL);
const db = createDatabase(config.DATABASE_URL);
const credentialDerivationSecret = await loadAccountAuthSecret(config);
const tokenEncryption = createTransportTokenEncryption(credentialDerivationSecret);
const notificationContentCipher = createNotificationContentCipher(credentialDerivationSecret);
await verifyCurrentTransportTokenEnvelopes(db);
await quarantineAbandonedProcessingClaims(db);
await cleanupTerminalDeviceAuthorizations(db);
await cancelUndeliverableDeliveryJobs(db);

let stopping = false;
const shutdown = new AbortController();
process.on("SIGTERM", () => { stopping = true; shutdown.abort(); });
process.on("SIGINT", () => { stopping = true; shutdown.abort(); });

/** Session facts become card endings here, beside card expiry; one failure never stops the cycle. */
async function reconcileSessions(mode: "disabled" | "sandbox" | "production"): Promise<void> {
  try {
    const result = await reconcileAgentSessions(db,mode);
    if (result.lost || result.cardsEnded || result.pruned) {
      console.info(JSON.stringify({ event: "agent_session_reconciled",...result }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "agent_session_reconcile_failed",
      message: error instanceof Error ? error.message : String(error) }));
  }
}

/** Content past RELO_CONTENT_RETENTION_HOURS is deleted every few minutes; a failure never stops the cycle. */
const CONTENT_RETENTION_INTERVAL_MS = 5*60_000;
let contentRetentionDueAt = 0;
async function pruneExpiredContent(): Promise<void> {
  const retentionHours = config.RELO_CONTENT_RETENTION_HOURS;
  if (retentionHours === undefined || Date.now()<contentRetentionDueAt) return;
  contentRetentionDueAt = Date.now()+CONTENT_RETENTION_INTERVAL_MS;
  try {
    const result = await runScheduledContentRetention(db,{
      retentionHours,releaseIdentity: config.RELO_RELEASE_IDENTITY ?? "worker",
    });
    if (result.eventsPruned || result.tombstonesExpired || result.cardsPruned) {
      console.info(JSON.stringify({ event: "content_retention",retentionHours,...result }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "content_retention_failed",
      message: error instanceof Error ? error.message : String(error) }));
  }
}

/** Content sealed only to readers that are gone (revoked devices, replaced keys) is deleted. */
let unreadablePurgeDueAt = 0;
async function purgeUnreadable(mode: "disabled" | "sandbox" | "production"): Promise<void> {
  if (Date.now()<unreadablePurgeDueAt) return;
  unreadablePurgeDueAt = Date.now()+CONTENT_RETENTION_INTERVAL_MS;
  try {
    const result = await purgeAllUnreadableContent(db,mode);
    if (result.cardsEnded || result.eventsPurged) console.info(JSON.stringify({ event: "unreadable_content_purged",...result }));
    const asked = await requestAllPendingApprovals(db,mode,notificationContentCipher);
    if (asked) console.info(JSON.stringify({ event: "device_approval_requested",devices: asked }));
  } catch (error) {
    console.warn(JSON.stringify({ event: "unreadable_content_purge_failed",
      message: error instanceof Error ? error.message : String(error) }));
  }
}

// Answer callbacks run beside APNs delivery in every mode; a slow endpoint never holds a push.
const CALLBACK_POLL_MS = 2_000;
const callbackLoop = (async () => {
  while (!shutdown.signal.aborted) {
    try {
      await dispatchDueInteractionCallbacks(db,{ encryption: tokenEncryption });
      // A question whose card never appeared on the phone is announced by one plain notification.
      if (config.APNS_MODE !== "disabled") {
        await notifyUnseenQuestionCards(db,{ apnsMode: config.APNS_MODE,contentCipher: notificationContentCipher });
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "interaction_callback_cycle_failed",
        message: error instanceof Error ? error.message : String(error) }));
    }
    await delay(CALLBACK_POLL_MS,undefined,{ signal: shutdown.signal }).catch(() => {});
  }
})();

if (config.APNS_MODE === "disabled") {
  console.warn(apnsOperationalLog("apns_worker_started",{
    mode: "disabled",releaseIdentity: config.RELO_RELEASE_IDENTITY ?? null,keyConfigured: false,
  }));
  await recordWorkerHeartbeat(db,{
    mode: "disabled",configured: false,pollMs: config.WORKER_POLL_MS,
    releaseIdentity: config.RELO_RELEASE_IDENTITY,
  });
  await writeFile("/tmp/relo-worker-ready", new Date().toISOString());
  while (!stopping) {
    await recordWorkerHeartbeat(db,{
      mode: "disabled",configured: false,pollMs: config.WORKER_POLL_MS,
      releaseIdentity: config.RELO_RELEASE_IDENTITY,
    });
    const cycle = emptyApnsWorkerCycle();
    const swept = await quarantineAbandonedProcessingClaims(db);
    cycle.safelyRequeued = swept.safelyRequeued;
    cycle.reconciliationRequired = swept.reconciliationRequired;
    cycle.expiredActivities = await expireDueActivities(db,"disabled");
    cycle.expiredInteractions = await expireDueInteractiveActivities(db,"disabled");
    await reconcileSessions("disabled");
    await pruneExpiredContent();
    await purgeUnreadable("disabled");
    cycle.canceledUndeliverable = await cancelUndeliverableDeliveryJobs(db);
    if (Object.values(cycle).some((value) => value > 0)) {
      console.info(apnsOperationalLog("apns_worker_cycle",{ mode: "disabled",...cycle }));
    }
    await delay(await nextInteractionExpiryDelay(db,config.WORKER_POLL_MS), undefined, { signal: shutdown.signal }).catch((error) => { if (!shutdown.signal.aborted) throw error; });
  }
} else {
  const apnsEnvironment = config.APNS_MODE;
  const validated = validateApnsWorkerConfig(config);
  const apnsCutoverAt = validated.cutoverAt;
  await assertPreparedApnsCutover(db,apnsCutoverAt,validated.configurationGeneration);
  const privateKey = await readProtectedApnsPrivateKey(config);
  const apns = new CleanroomApnsRuntime(
    db,
    cleanroomProviderConfig(config, privateKey),
    new NodeHttp2ApnsTransport(),
  );
  const wakeup = await DeliveryJobWakeup.listen(db);
  const concurrency = Math.min(config.APNS_LOCAL_CONCURRENCY_CAP,config.WORKER_BATCH_SIZE);
  const reservedUrgent = Math.min(config.WORKER_URGENT_RESERVED_SLOTS ?? 2,concurrency-1);
  try {
    await apns.warm(shutdown.signal);
    console.info(apnsOperationalLog("apns_worker_started",{
      mode: config.APNS_MODE,releaseIdentity: config.RELO_RELEASE_IDENTITY ?? null,
      configurationGeneration: validated.configurationGeneration,keyConfigured: true,http2SessionWarm: true,
      dispatchConcurrencyCap: concurrency,reservedUrgentSlots: reservedUrgent,
      workerBatchSize: config.WORKER_BATCH_SIZE,pollFallbackMs: config.WORKER_POLL_MS,
    }));
    await db.query(
      `UPDATE delivery_jobs j SET state='canceled',lease_expires_at=NULL,
         last_error_code='pre_apns_cutover',last_error_message='Quarantined before APNs enablement',updated_at=now()
       FROM notification_events e WHERE e.id=j.notification_event_id AND e.created_at<$1
         AND j.state IN ('pending','retry')`,
      [apnsCutoverAt],
    );
    await recordWorkerHeartbeat(db,{
      mode: config.APNS_MODE,configured: true,pollMs: config.WORKER_POLL_MS,
      releaseIdentity: config.RELO_RELEASE_IDENTITY,
    });
    await writeFile("/tmp/relo-worker-ready", new Date().toISOString());
    let maintenanceFailure: unknown;
    const maintenance = (async () => {
      while (!shutdown.signal.aborted) {
        await delay(await nextInteractionExpiryDelay(db,config.WORKER_POLL_MS), undefined, { signal: shutdown.signal });
        await recordWorkerHeartbeat(db,{
          mode: config.APNS_MODE,configured: true,pollMs: config.WORKER_POLL_MS,
          releaseIdentity: config.RELO_RELEASE_IDENTITY,
        });
        const cycle = emptyApnsWorkerCycle();
        const swept = await quarantineAbandonedProcessingClaims(db);
        cycle.safelyRequeued = swept.safelyRequeued;
        cycle.reconciliationRequired = swept.reconciliationRequired;
        cycle.expiredActivities = await expireDueActivities(db,config.APNS_MODE);
        cycle.expiredInteractions = await expireDueInteractiveActivities(db,config.APNS_MODE);
        await reconcileSessions(config.APNS_MODE);
        await pruneExpiredContent();
        await purgeUnreadable(config.APNS_MODE);
        cycle.canceledUndeliverable = await cancelUndeliverableDeliveryJobs(db);
        if (Object.values(cycle).some(value => value > 0)) {
          console.info(apnsOperationalLog("apns_worker_cycle",{ mode: config.APNS_MODE,wakeReason: "maintenance",...cycle }));
        }
      }
    })().catch(error => {
      if (error instanceof Error && error.name === "AbortError" && shutdown.signal.aborted) return;
      maintenanceFailure = error;
      shutdown.abort();
    });
    const dispatcher = new DeliveryDispatcher<ClaimedDeliveryJob>({
      concurrency,
      reservedUrgent,
      claim: (limit,lane) => claimDeliveryJobs(db,limit,apnsCutoverAt,lane),
      wait: async signal => {
        const timeout = await nextDeliveryWakeDelay(db,config.WORKER_POLL_MS,apnsCutoverAt);
        await wakeup.wait(timeout,signal);
      },
      dispatch: async (job) => {
      const cycle = emptyApnsWorkerCycle();
      cycle.claimed = 1;
      cycle.queueToFirstClaimMaxMs = Math.max(0,(job.first_claimed_at ?? job.last_claimed_at ?? job.created_at).getTime()-job.created_at.getTime());
      let dispatchStarted = false;
      let providerResult: ApnsRuntimeResult | undefined;
      let providerResultObserved = false;
      try {
        const storedCommand = job.payload?.liveActivity;
        const projectedCommand = storedCommand && typeof storedCommand === "object" && !Array.isArray(storedCommand)
          ? projectLiveActivityInteraction(job,storedCommand as Record<string,unknown>,credentialDerivationSecret)
          : storedCommand;
        const providerPriority = apnsPriorityForJob({
          transport: job.transport,
          ...(projectedCommand && typeof projectedCommand === "object" && !Array.isArray(projectedCommand)
            ? { command: projectedCommand as Record<string,unknown> }
            : {}),
          requesterCredentialId: job.requester_credential_id,
          requesterServiceId: job.service_id,
        });
        const command = projectedCommand && typeof projectedCommand === "object" && !Array.isArray(projectedCommand)
          ? { ...projectedCommand as Record<string,unknown>,priority: providerPriority }
          : projectedCommand;
        const activityGeneration = command && typeof command === "object" && !Array.isArray(command)
          && Number.isSafeInteger((command as Record<string,unknown>).generation)
          && Number((command as Record<string,unknown>).generation) > 0
          ? Number((command as Record<string,unknown>).generation)
          : undefined;
        if (job.transport === "live_activity_update" && activityGeneration === undefined) {
          throw new Error("Live Activity update command is missing a positive generation");
        }
        const inputs = job.transport === "notification"
          ? await pinOrdinaryDeliveryInputs(db,job,async () => ({
            badge: await pendingInteractionBadgeCount(db,job.device_id),avatarUrl: job.service_image_url,
          }))
          : { badge: 0,avatarUrl: job.service_image_url };
        let runtimeJob: ApnsRuntimeJob = {
          id: job.id,
          claimToken: job.claim_token,
          attemptCount: job.attempt_count,
          providerAttemptsUsed: job.provider_attempts_used,
          providerRetryStartedAt: job.provider_retry_started_at,
          providerRetryAttemptCap: job.provider_retry_attempt_cap,
          providerRetryHorizonAt: job.provider_retry_horizon_at,
          providerNextAttemptNotBefore: job.provider_next_attempt_not_before,
          providerStatus: job.provider_status,
          transport: job.transport,
          createdAt: job.created_at,
          expiresAt: job.expires_at,
          title: job.title,
          body: job.body,
          sourceName: job.source,
          conversationId: job.origin_hash ?? eventConversationId({
            eventId: job.event_id,title: job.title,interactionId: job.interaction_id,
            serviceId: job.service_id,credentialId: job.requester_credential_id,
          }),
          collapseId: job.origin_hash,
          avatarUrl: inputs.avatarUrl,
          imageUrl: job.image_url,
          deepLink: job.deep_link,
          notificationId: publicId("ntf",job.event_id),
          accountId: publicId("acc",job.principal_id),
          deviceId: publicId("dev",job.device_id),
          serverOriginHash: configuredReceiptOriginHash,
          interactionExpiresAt: job.interaction_expires_at,
          interactionKind: job.interaction_kind,
          interactionId: job.interaction_id ? publicId("int",job.interaction_id) : null,
          badge: inputs.badge,
          payload: job.payload,
          ...(command && typeof command === "object" && !Array.isArray(command)
            ? { activityCommand: command as Record<string,unknown> }
            : {}),
        };
        if (job.transport === "notification") {
          await pinDeliverySerializationEvidence(db,job,deliverySerializationEvidence(runtimeJob));
          await markDeliveryDispatchStarted(db,job.id,job.claim_token,providerPriority);
        } else {
          const frame = await prepareLatestActivityFrame(db,job,command as Record<string,unknown>,providerPriority,
            (timestamp,transport) => {
              runtimeJob = { ...runtimeJob,transport,activityCommand: {
                ...runtimeJob.activityCommand,providerTimestamp: timestamp,
                ...(transport === "live_activity_start" ? { alertOwner: "apns" } : {}),
              } };
              return deliverySerializationEvidence(runtimeJob);
            });
          if (frame.kind !== "ready") {
            if (frame.kind === "deferred" && frame.reason === "clock_rollback") {
              console.warn(apnsOperationalLog("apns_worker_cycle",{
                mode: config.APNS_MODE,clockHealth: "rollback",frameOutcome: "deferred",
              }));
            }
            return;
          }
        }
        dispatchStarted = true;
        const resolver = new PostgresApnsRecipientResolver({
          db,
          encryption: tokenEncryption,
          kind: runtimeJob.transport,
          deliveryJobId: job.id,
          claimToken: job.claim_token,
          principalId: job.principal_id,
          deviceId: job.device_id,
          notificationEventId: job.event_id,
          environment: apnsEnvironment,
          ...(job.live_activity_id ? { liveActivityId: job.live_activity_id } : {}),
          ...(activityGeneration === undefined ? {} : { liveActivityGeneration: activityGeneration }),
        });

        providerResult = await withJobLeaseHeartbeat(
          db,job.id,job.claim_token,shutdown.signal,
          async (signal) => await apns.send({ ...runtimeJob,signal },resolver),
        );
        observeApnsRuntimeResult(cycle,providerResult);
        providerResultObserved = true;
        if (shutdown.signal.aborted) {
          cycle.reconciliationFenced += 1;
          await markDeliveryClaimForReconciliation(
            db,job,"shutdown_during_provider_dispatch",
            "Worker shutdown interrupted a dispatch after its durable fence",
            providerResult.kind === "accepted" ? providerResult.providerMessageId : undefined,
          );
          return;
        }
        if (providerResult.kind === "reconcile") {
          await markDeliveryClaimForReconciliation(
            db,job,providerResult.code,providerResult.message,providerResult.providerMessageId,
          );
          return;
        }
        if (providerResult.kind === "unavailable") {
          if (job.transport === "notification") {
            await cancelUnavailableDeliveryClaim(db,job,providerResult);
          } else {
            await deferMissingActivityToken(db,job,shouldRetryMissingActivityToken(job));
          }
          return;
        }
        await finalizeDeliveryClaim(db,job,providerResult);
      } catch (error) {
        if (error instanceof DeliveryClaimOwnershipLostError) {
          cycle.ownershipLost += 1;
          return;
        }
        if (error instanceof DeliverySerializationMismatchError) {
          cycle.serializationMismatches += 1;
          await quarantineDeliverySerializationMismatch(db,job);
          return;
        }
        if (error instanceof DeliverySerializationValidationError) {
          cycle.serializationFailures += 1;
          await quarantineInvalidDeliverySerialization(db,job);
          return;
        }
        if (!dispatchStarted) {
          cycle.preparationFailed += 1;
          await retryPreparingDeliveryClaim(db,job);
          return;
        }
        const ambiguous = error instanceof ApnsOutcomePersistenceError ? error.result : providerResult;
        if (ambiguous && !providerResultObserved) observeApnsRuntimeResult(cycle,ambiguous);
        cycle.reconciliationFenced += 1;
        await markDeliveryClaimForReconciliation(
          db,job,
          ambiguous?.kind === "accepted"
            ? "known_apns_acceptance_persistence_failed"
            : "provider_dispatch_persistence_failed",
          ambiguous?.kind === "accepted"
            ? "APNs accepted the request but final durable state was not confirmed"
            : "A dispatch crossed its durable fence without a confirmed final state",
          ambiguous?.kind === "accepted" ? ambiguous.providerMessageId : undefined,
        );
      } finally {
        console.info(apnsOperationalLog("apns_worker_cycle",{ mode: config.APNS_MODE,wakeReason: "dispatch",...cycle }));
      }
      },
    });
    try {
      await dispatcher.run(shutdown.signal);
    } finally {
      shutdown.abort();
      await maintenance;
    }
    if (maintenanceFailure) throw maintenanceFailure;
  } finally {
    await Promise.allSettled([apns.close(),wakeup.close()]);
  }
}
shutdown.abort();
await callbackLoop;
console.info(apnsOperationalLog("apns_worker_stopped",{ mode: config.APNS_MODE }));
await db.end();
