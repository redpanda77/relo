import type { Database } from "../db.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { z } from "zod";
import { relevanceItemSchema } from "@relo/notification-contracts";
import { credentialConversationId } from "../communication.js";
import { publicId } from "../ids.js";
import { persistNotificationContent } from "../notification-content.js";
import { assertOrdinaryDeliveryIntentWithinBudget } from "../delivery-serialization.js";
import { independentSubjectKey,lockSubjectAdmission } from "../relevance/commands.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";
import {
  lockWithdrawableNotification,persistWithdrawal,eligibleNotificationDevices,insertNotificationEvent,
  notificationReceiptByKey,notificationReceiptById,insertNotificationDelivery,saveNotificationDelivery,type CreationEventRow,
} from "./store.js";
import type {
  NotificationActor,WithdrawNotificationCommand,WithdrawNotificationResult,CreateNotificationCommand,
  CreateNotificationResult,NotificationReceipt,NotificationDependencies,
} from "./types.js";

export async function withdrawNotification(db: Database,actor: NotificationActor,
  command: WithdrawNotificationCommand): Promise<WithdrawNotificationResult> {
  const tx=await db.connect();
  try {
    await tx.query("BEGIN");
    const event=await lockWithdrawableNotification(tx,actor,command.eventId);
    if(!event) {await tx.query("ROLLBACK");return {kind:"not_found"};}
    if(event.withdrawn_at) {
      await tx.query("COMMIT");
      return {kind:"withdrawn",eventId:event.id,withdrawnAt:event.withdrawn_at,replayed:true};
    }
    const result=await persistWithdrawal(tx,actor,command);
    await tx.query("COMMIT");
    return {kind:"withdrawn",eventId:event.id,...result,replayed:false};
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}

const deliverySchema=z.object({eligibleDevices:z.number().int().nonnegative(),durableCommands:z.number().int().nonnegative(),apnsJobs:z.number().int().nonnegative()}).strict();
const interactionStateSchema=z.enum(["pending","approved","denied","yes","no","replied","expired","canceled"]);

function parseReceipt(row: CreationEventRow,eligibleDevices: number): NotificationReceipt {
  const delivery=deliverySchema.safeParse(row.delivery_summary??{eligibleDevices,durableCommands:1,apnsJobs:0});
  const relevance=relevanceItemSchema.nullable().safeParse(row.relevance);
  if(!delivery.success||!relevance.success) throw new Error("notification_receipt_invalid");
  let interaction:NotificationReceipt["interaction"]=null;
  if(row.interaction_id!==null) {
    const state=interactionStateSchema.safeParse(row.interaction_state);
    if(!state.success||!(row.interaction_expires_at instanceof Date)||!Number.isFinite(row.interaction_expires_at.getTime())) throw new Error("notification_receipt_invalid");
    interaction={id:row.interaction_id,state:state.data,expiresAt:row.interaction_expires_at};
  }
  return {eventId:row.id,createdAt:row.created_at,delivery:delivery.data,relevance:relevance.data,interaction};
}

/** The caller owns the transaction. A replay may have inserted a provisional
 * event before canonical version arbitration and MUST roll back. Nested activity
 * callers accept only created and let their outer transaction abort otherwise. */
export async function createNotificationInTransaction(tx: SubjectTransaction,actor: NotificationActor,
  command: CreateNotificationCommand,dependencies: NotificationDependencies): Promise<CreateNotificationResult> {
  const sourceId=actor.kind==="credential"?`credential:${actor.credentialId}`:actor.kind==="service"?`service:${actor.serviceId}`:`account:${actor.principalId}`;
  const subjectActor={principalId:actor.principalId,sourceId};
  await lockSubjectAdmission(tx,subjectActor,command.relevance?.subjectKey??independentSubjectKey(command.idempotencyKey));
  const eligible=await eligibleNotificationDevices(tx,actor,command.deviceIds);
  if(command.deviceIds&&eligible.length!==command.deviceIds.length) return {kind:"invalid_device_selection"};
  const event=await insertNotificationEvent(tx,actor,command);
  if(!event) {
    const receipt=await notificationReceiptByKey(tx,actor,command.idempotencyKey);
    if(!receipt||receipt.request_hash!==command.requestHash) return {kind:"idempotency_conflict"};
    return {kind:"replayed",...parseReceipt(receipt,eligible.length)};
  }
  const admission=await admitOrdinaryEvent(tx,subjectActor,{
    eventId:event.id,createdAt:event.created_at,idempotencyKey:command.idempotencyKey,
    intentHash:command.requestHash,relevance:command.relevance,apnsMode:dependencies.apnsMode,
    ...(command.interaction?{kind:"decision" as const,interaction:command.interaction,actionDeadlineCap:command.interaction.actionDeadlineCap}:{kind:"notice" as const}),
  });
  if(admission.kind==="duplicate") return {kind:"replayed",...parseReceipt(await notificationReceiptById(tx,admission.eventId),0),relevance:admission.relevance};
  // Legacy decision-only runtimes can operate without the optional content key.
  // Notice adapters require it before admission, preserving their existing gate.
  if(dependencies.contentCipher) await persistNotificationContent(tx,dependencies.contentCipher,event.id,command.content);
  else if(!command.interaction) throw new Error("content_encryption_unavailable");
  const request=admission.request;
  const conversationId=request?publicId("int",request.id):command.originHash??(actor.kind==="credential"
    ?credentialConversationId(actor.credentialId,command.title):actor.kind==="service"?publicId("svc",actor.serviceId):null);
  assertOrdinaryDeliveryIntentWithinBudget({title:command.title,body:command.content.preview,sourceName:command.sourceName,
    conversationId,avatarUrl:command.avatarUrl??null,imageUrl:command.imageUrl,deepLink:command.deepLink,notificationId:publicId("ntf",event.id),
    interactionKind:command.interaction?.kind??null,payload:{...command.payload,...(request?{interactionId:publicId("int",request.id),interactionType:command.interaction!.kind}:{})}});
  const apnsJobs=await insertNotificationDelivery(tx,actor,event.id,command.deviceIds,dependencies.apnsMode);
  const delivery={eligibleDevices:eligible.length,durableCommands:1,apnsJobs};
  await saveNotificationDelivery(tx,event.id,delivery);
  return {kind:"created",eventId:event.id,createdAt:event.created_at,delivery,relevance:admission.relevance,
    interaction:request?{id:request.id,state:request.state,expiresAt:request.expires_at}:null};
}

export async function createNotification(db: Database,actor: NotificationActor,command: CreateNotificationCommand,
  dependencies: NotificationDependencies): Promise<CreateNotificationResult> {
  const tx=await db.connect();
  try {
    await tx.query("BEGIN");
    const result=await createNotificationInTransaction(tx,actor,command,dependencies);
    await tx.query(result.kind==="created"?"COMMIT":"ROLLBACK");
    return result;
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}
