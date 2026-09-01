import { createHash } from "node:crypto";
import { publicId } from "./ids.js";

export function normalizedConversationTitle(title: string): string {
  return title.trim().toLocaleLowerCase("en-US").replace(/\s+/g," ");
}

export function credentialConversationId(credentialId: string, title: string): string {
  const titleDigest = createHash("sha256")
    .update(normalizedConversationTitle(title),"utf8")
    .digest("hex")
    .slice(0,16);
  return `${publicId("key",credentialId)}:${titleDigest}`;
}

export function eventConversationId(input: {
  eventId: string;
  title: string;
  interactionId?: string | null;
  serviceId?: string | null;
  credentialId?: string | null;
}): string {
  if (input.interactionId) return publicId("int",input.interactionId);
  if (input.serviceId) return publicId("svc",input.serviceId);
  if (input.credentialId) return credentialConversationId(input.credentialId,input.title);
  return publicId("ntf",input.eventId);
}
