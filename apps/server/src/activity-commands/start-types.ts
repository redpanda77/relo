import type { LiveActivityPresentation } from "@relo/notification-contracts";
import type { z } from "zod";
import type { NotificationContentCipher } from "../notification-content.js";
import type { resolveActivityPresentation } from "../presentation-policy.js";
import type { persistedPresentationColumns } from "../presentation-runtime.js";
import type { ActivityDeliverySummary,activityStartSchema,ApnsMode } from "./schemas.js";
import type { ActivityRow,ActivitySnapshot } from "./types.js";
import type { ProducerType } from "@relo/notification-contracts";

/** The work a card projects and its producer identity, written with the card's first insert (never patched in after). */
export type CardIdentity={workId:string;producerType:ProducerType;sessionKey:string|null};

export type ProducerStartCommand={
  operation:"start";source:"producer";rawInput:z.infer<typeof activityStartSchema>;
  storedPresentation:ReturnType<typeof persistedPresentationColumns>;
  presentationPolicy:ReturnType<typeof resolveActivityPresentation>["snapshot"];
  requestedDeviceIds:string[]|null;idempotencyKey:string|undefined;requestHash:string;apnsMode:ApnsMode;
  cardIdentity?:CardIdentity;
};
export type ActivityStartReceipt={
  activity:ActivitySnapshot;delivery:ActivityDeliverySummary;queued:number;
  replayed?:boolean;disposition?:string;reused?:boolean;resumed?:boolean;replaced?:number;
};
export type ActivityStartFailure={error:string;code?:string;message?:string;disposition?:string;activityId?:string};
export type ActivityStartResult<T=ActivityStartReceipt>=
 |{kind:"started";created:boolean;receipt:T}
 |{kind:"start_rejected";reason:ActivityStartFailure;category:"invalid"|"conflict"|"missing"};
export const startAccepted=<T>(receipt:T,created:boolean):ActivityStartResult<T>=>({kind:"started",created,receipt});
export const startRejected=(reason:ActivityStartFailure,category:"invalid"|"conflict"|"missing"):Extract<ActivityStartResult,{kind:"start_rejected"}>=>({kind:"start_rejected",reason,category});

export type OwnerStartCommand={
  operation:"start";source:"owner";
  input:{deviceId:string;presentation:LiveActivityPresentation;allowParallel:boolean};
  deviceId:string;apnsMode:ApnsMode;contentCipher:NotificationContentCipher;
  lease:{idleSeconds:number;hardSeconds:number;staleSeconds:number};
  configuration:{
    style:string;sourceName:string;accentColor:string|null;title:string;detail:string|null;
    status:string;progress:number|null;symbol:string;privacyMode:string;
    interactionKind:"approval"|"yes_no"|null;
    stored:ReturnType<typeof persistedPresentationColumns>;presentation:LiveActivityPresentation;
  };
};
export type OwnerStartReceipt={
  activity:{id:string;style:string;title:string;operation:"start"|"update";generation:number;sequence:number;presentationHash:string;ownerKind:string};
  presentation:LiveActivityPresentation;transportMode:string;eventId:string;companionEventId:string|null;
  interaction:Record<string,unknown>|null;device:{id:string;name:string};
  queued:number;delivery:ActivityDeliverySummary;disposition:string;reused:boolean;resumed:boolean;
  replaced:number;replacedEventIds:string[];
};
export type OwnerStartResult=ActivityStartResult<OwnerStartReceipt>;

export type ActivityStartRow=ActivityRow & {
  presentation_policy_source:string|null;start_idempotency_key:string|null;start_request_hash:string|null;start_snapshot:ActivitySnapshot|null;
  start_delivery_summary:unknown;start_replace_requested:boolean;start_replaced_count:number;
};
export type ActivityStartDevice={id:string;name:string;apns_token:string|null;apns_environment:string;
  notification_authorization:string;live_activity_authorization:string;live_activity_push_to_start_token:string|null};
