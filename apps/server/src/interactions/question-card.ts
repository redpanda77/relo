import { cardLimitBody,cardLimitReached } from "../card-limit.js";
import type { ApnsMode } from "../activities.js";
import type { ChoiceOption } from "@relo/notification-contracts";
import { assertChoiceTargets,CHOICE_CAPABILITY,ChoiceUnsupportedError,choiceUnsupportedBody,questionBehavior } from "../choice-questions.js";
import { publicId } from "../ids.js";
import { persistNotificationContent,prepareNotificationContent,type NotificationContentCipher } from "../notification-content.js";
import { presentationCommandProjection,terminalPresentationColumnsFromRow,canonicalPresentation,
  persistedPresentationColumns } from "../presentation-runtime.js";
import { resolveActivityPresentation,SYSTEM_PRESENTATION_POLICY,systemPresentationPolicySnapshot } from "../presentation-policy.js";
import { independentSubjectKey,lockSubjectAdmission,type SubjectCommand,type SubjectTransaction } from "../relevance/commands.js";
import { relevanceDeliveryGuard } from "../relevance/delivery.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";

/** Who asks: a CLI credential or a service. Its decision is answered on the card or in the app. */
export type QuestionCardRequester = {
  principalId: string; sourceId: string; credentialId: string | null; serviceId: string | null;
};

export type QuestionCardInput = {
  type: "approval" | "yes_no" | "choice"; title: string; prompt: string; detail?: string | undefined; expiresInSeconds: number;
  primaryLabel?: string | undefined; secondaryLabel?: string | undefined; options?: ChoiceOption[] | undefined;
  privacy?: "standard" | "private" | undefined; style?: string | undefined;
  context?: Record<string,any> | undefined; relevance?: SubjectCommand | undefined;
};

export type QuestionCardResult =
  | { kind: "rejected"; commit: false; status: 400 | 409 | 503; body: { error: string; message?: string; devices?: string[] } }
  | { kind: "created" | "replayed"; commit: boolean; interactionRequestId: string; body: Record<string,unknown> };

/**
 * A question that is its own Live Activity: the card asks, the answer ends it. The caller owns the
 * transaction and commits only when `commit` is true.
 */
export async function createQuestionCardInTransaction(client: SubjectTransaction,requester: QuestionCardRequester,
  input: QuestionCardInput,options: {
    idempotencyKey: string; requestHash: string; sourceName: string; originHash: string | null;
    requestedDeviceIds: string[] | null; apnsMode: ApnsMode; deliveryApnsMode: ApnsMode | undefined;
    contentCipher?: NotificationContentCipher | null | undefined;
  }): Promise<QuestionCardResult> {
  const { idempotencyKey,requestHash,sourceName,originHash,requestedDeviceIds,apnsMode,deliveryApnsMode } = options;
  if (input.detail && !options.contentCipher) {
    return { kind: "rejected",commit: false,status: 503,body: { error: "content_encryption_unavailable" } };
  }
  const interactivePresentation = canonicalPresentation({
    content: {
      header: input.title,title: input.title,subtitle: input.prompt,status: "Waiting for input",
    },
    identity: resolveActivityPresentation({ context: input.context },{
      principalId: requester.principalId,effective: { policy: SYSTEM_PRESENTATION_POLICY,source: "system" },
    }).stored.presentation.identity,
    state: { kind: "needs_action",tone: "attention",icon: "needs_action" },
    components: [],surfaces: {},
    behavior: questionBehavior(input.type,{ primary: input.primaryLabel,secondary: input.secondaryLabel,options: input.options }),
    appearance: { theme: "system",roles: {
      cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
    } },
    privacy: input.privacy ?? "standard",
  });
  const interactiveStored = persistedPresentationColumns(interactivePresentation);
  await lockSubjectAdmission(client,{ principalId: requester.principalId,sourceId: requester.sourceId },
    input.relevance?.subjectKey ?? independentSubjectKey(idempotencyKey));
  const cap = await cardLimitReached(client,requester.credentialId);
  if (cap !== null) return { kind: "rejected",commit: false,status: 409,body: cardLimitBody(cap) };
  // A choice reaches only phones that can show it: named phones must all be able to, and without
  // names the question goes to the phones that can.
  const choice = input.type === "choice";
  try {
    if (choice && requestedDeviceIds) await assertChoiceTargets(client,requester.principalId,requestedDeviceIds);
  } catch (error) {
    if (error instanceof ChoiceUnsupportedError) return { kind: "rejected",commit: false,status: 409,body: choiceUnsupportedBody(error) };
    throw error;
  }
  const eligible = await client.query<any>(
    `SELECT id,apns_environment,live_activity_push_to_start_token
     FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
       AND live_activity_authorization='authorized'
       AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
       AND (NOT $3 OR $4=ANY(capabilities))
     ORDER BY last_seen_at DESC,id LIMIT 50`,
    [requester.principalId,requestedDeviceIds,choice,CHOICE_CAPABILITY],
  );
  if (choice && !eligible.rowCount) {
    try { await assertChoiceTargets(client,requester.principalId,null); }
    catch (error) {
      if (error instanceof ChoiceUnsupportedError) return { kind: "rejected",commit: false,status: 409,body: choiceUnsupportedBody(error) };
      throw error;
    }
  }
  if (!eligible.rowCount || (requestedDeviceIds && eligible.rowCount !== requestedDeviceIds.length)) {
    return { kind: "rejected",commit: false,status: 400,
      body: { error: requestedDeviceIds ? "invalid_device_selection" : "no_eligible_device" } };
  }
  const device = eligible.rows[0]!;
  const eligibleDeviceIds = eligible.rows.map((row: any) => row.id);
  const event = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO notification_events(
       principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,idempotency_key,expires_at,
       request_hash,target_mode,origin_hash
     ) VALUES ($1,$2,$11,$3,'live_activity',$4,$5,$9::jsonb,$6,now()+($7*interval '1 second'),$8,'explicit',$10)
     ON CONFLICT DO NOTHING RETURNING id,created_at`,
    [requester.principalId,requester.credentialId,sourceName,input.title,input.prompt,idempotencyKey,
      input.expiresInSeconds,requestHash,input.context ? { context: input.context } : {},originHash,requester.serviceId],
  );
  if (!event.rowCount) {
    const existing = await client.query<any>(
      `SELECT r.id,r.state,e.id AS event_id,e.request_hash,e.delivery_summary,
         e.payload#>>'{liveActivity,activityId}' AS activity_id,
         (SELECT relevance FROM notification_relevance nr WHERE nr.notification_event_id=e.id) AS relevance
       FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
       WHERE e.principal_id=$1 AND e.requester_credential_id IS NOT DISTINCT FROM $2
         AND e.requester_service_id IS NOT DISTINCT FROM $4 AND e.idempotency_key=$3`,
      [requester.principalId,requester.credentialId,idempotencyKey,requester.serviceId],
    );
    if (!existing.rowCount || existing.rows[0].request_hash !== requestHash
      || !existing.rows[0].activity_id) {
      return { kind: "rejected",commit: false,status: 409,body: { error: "idempotency_conflict" } };
    }
    const delivery = existing.rows[0].delivery_summary
      ?? { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 };
    return { kind: "replayed",commit: true,interactionRequestId: existing.rows[0].id,body: {
      interaction: { id: publicId("int",existing.rows[0].id), state: existing.rows[0].state },
      eventId: publicId("ntf",existing.rows[0].event_id),
      liveActivityId: existing.rows[0].activity_id,
      delivery, queued: delivery.apnsJobs, replayed: true,relevance: existing.rows[0].relevance,
    } };
  }
  const admission = await admitOrdinaryEvent(client,{
    principalId: requester.principalId,sourceId: requester.sourceId,
  },{
    apnsMode,kind: "decision",eventId: event.rows[0]!.id,intentHash: requestHash,
    relevance: input.relevance,idempotencyKey,createdAt: event.rows[0]!.created_at,
    interaction: { kind: input.type,prompt: input.prompt,actionSeconds: input.expiresInSeconds,options: input.options },
  });
  if (admission.kind === "duplicate") {
    const receipt = (await client.query<any>(
      `SELECT r.id,r.state,e.delivery_summary,e.payload#>>'{liveActivity,activityId}' AS activity_id
       FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id WHERE e.id=$1`,
      [admission.eventId],
    )).rows[0]!;
    const delivery = receipt.delivery_summary ?? { eligibleDevices: 0,durableCommands: 0,apnsJobs: 0 };
    return { kind: "replayed",commit: false,interactionRequestId: receipt.id,body: {
      interaction: { id: publicId("int",receipt.id),state: receipt.state },
      eventId: publicId("ntf",admission.eventId),liveActivityId: receipt.activity_id,
      delivery,queued: delivery.apnsJobs,replayed: true,relevance: admission.relevance } };
  }
  const request = admission.request!;
  const expired = request.state === "expired";
  const display = expired ? terminalPresentationColumnsFromRow({ presentation: interactivePresentation },"Expired","warning")
    : interactiveStored;
  const style = expired ? display.style : input.style ?? "approval";
  const activity = await client.query<any>(
    `INSERT INTO live_activities(
       principal_id,requester_credential_id,requester_service_id,activity_key,title,status,detail,progress,symbol,style,
       privacy,accent_color,target_device_ids,start_idempotency_key,expires_at,stale_at,
       presentation,presentation_sha256,presentation_policy,presentation_policy_source,
       presentation_preset_id,presentation_preset_revision,state,ended_at,context,origin_hash
     ) VALUES ($1,$2,$19,NULL,$3,$13,$4,NULL,$14,$5,$18,'#5ED8B7',
       $6::uuid[],$7,$8::timestamptz,$8::timestamptz,$9::jsonb,$10,
       $11::jsonb,'system',$12,1,$15::live_activity_state,CASE WHEN $15='expired' THEN clock_timestamp() ELSE NULL END,$16::jsonb,$17) RETURNING *`,
    [requester.principalId,requester.credentialId,input.title,input.prompt,style,eligibleDeviceIds,
      `interaction:${idempotencyKey}`,request.expires_at,
      display.presentation,display.presentationHash,
      systemPresentationPolicySnapshot(`system.interactive.${input.style ?? "approval"}`),`system.interactive.${input.style ?? "approval"}`,
      display.status,display.symbol,expired ? "expired" : "active",input.context ?? {},originHash,
      display.privacy,requester.serviceId],
  );
  await client.query(
    `INSERT INTO notification_event_targets(notification_event_id,device_id)
     SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [event.rows[0]!.id,eligibleDeviceIds],
  );
  // The detail is read in Relo, encrypted like any message body; the card carries only the question.
  if (input.detail && options.contentCipher) {
    await persistNotificationContent(client,options.contentCipher,event.rows[0]!.id,
      prepareNotificationContent({ body: input.detail,summary: input.prompt,bodyFormat: "markdown" }));
  }
  const liveActivityId = publicId("act",activity.rows[0].id);
  const command = {
    operation: expired ? "end" : "start", activityId: liveActivityId, targetDeviceId: publicId("dev",device.id),
    generation: Number(activity.rows[0].generation),
    ...presentationCommandProjection(display.presentation),
    style, sourceName, privacy: display.privacy,
    expiresAt: new Date(activity.rows[0].expires_at).toISOString(),
    staleAt: new Date(activity.rows[0].stale_at).toISOString(),
    alertOwner: expired ? "none" : "app",
    sequence: 0, dismissAfterSeconds: null, interaction: null,
  };
  await client.query(
    "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
    [event.rows[0]!.id,{ ...(input.context ? { context: input.context } : {}),liveActivity: command, interactionId: publicId("int",request.id),
      interactionType: input.type }],
  );
  const remote = deliveryApnsMode === "disabled" ? { rowCount: 0 } : await client.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
     SELECT $1,d.id,'live_activity_start',$3 FROM devices d JOIN notification_events e ON e.id=$1
     WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4
       AND d.apns_environment=$5::apns_environment
       AND d.live_activity_push_to_start_token IS NOT NULL
       AND e.state='active' AND ${relevanceDeliveryGuard("e")}
     ON CONFLICT DO NOTHING`,
    [event.rows[0]!.id,eligibleDeviceIds,activity.rows[0].id,requester.principalId,deliveryApnsMode],
  );
  const delivery = { eligibleDevices: eligible.rows.length, durableCommands: expired ? 0 : eligible.rows.length,
    apnsJobs: remote.rowCount ?? 0 };
  await client.query(
    "UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
    [event.rows[0]!.id,delivery],
  );
  return { kind: "created",commit: true,interactionRequestId: request.id,body: {
    interaction: { id: publicId("int",request.id), state: request.state },
    eventId: publicId("ntf",event.rows[0]!.id), liveActivityId,
    delivery, queued: delivery.apnsJobs, replayed: false,relevance: admission.relevance,
  } };
}
