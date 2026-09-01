import type { LiveActivityPresentationPolicy } from "@relo/notification-contracts"

export { liveActivityPresentationPolicySchema as presentationPolicySchema } from "@relo/notification-contracts"
export type { LiveActivityPresentationPolicy as PresentationPolicy } from "@relo/notification-contracts"

export type PresentationPolicySource =
  "client" | "service" | "account" | "system"

export const systemPresentationPolicy: LiveActivityPresentationPolicy = {
  preset: "automatic",
  theme: "system",
  symbol: "automatic",
  colorStrategy: "thread",
  accentColor: "#5ED8B7",
}
