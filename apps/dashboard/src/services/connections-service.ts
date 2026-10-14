import type { ConnectionService } from "@/features/connections/types"
import type {
  PresentationPolicy,
  PresentationPolicySource,
} from "@/features/presentation-policy/types"

export type ServiceDefaults = {
  title: string
  imageUrl: string | null
  destinationUrl: string | null
}

export type IssuedService = {
  service: Pick<ConnectionService, "id" | "title" | "prefix"> &
    Partial<
      Pick<
        ConnectionService,
        | "imageUrl"
        | "destinationUrl"
        | "liveActivityPolicy"
        | "effectiveLiveActivityPolicy"
        | "liveActivityPolicySource"
      >
    >
  webhookUrl: string
}

export interface ConnectionsService {
  createService(input: ServiceDefaults): Promise<IssuedService>
  editService(
    id: string,
    input: ServiceDefaults
  ): Promise<{
    service: Omit<ConnectionService, "createdAt">
  }>
  rotateService(id: string): Promise<IssuedService>
  deleteService(id: string): Promise<void>
  revokePhone(id: string): Promise<void>
  revokeClient(id: string): Promise<void>
  revokeHarnessCredential(id: string): Promise<void>
  setClientCardLimit(id: string, limit: number | null): Promise<void>
  saveServiceLiveActivityPolicy(
    id: string,
    input: PresentationPolicy
  ): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
  resetServiceLiveActivityPolicy(id: string): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
  saveClientLiveActivityPolicy(
    id: string,
    input: PresentationPolicy
  ): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
  resetClientLiveActivityPolicy(id: string): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
}

async function jsonRequest<Result>(
  path: string,
  init?: RequestInit
): Promise<Result> {
  const response = await fetch(path, init)
  const payload = (await response.json().catch(() => null)) as
    Result | { error?: string; message?: string } | null
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? ("error" in payload && payload.error) ||
          ("message" in payload && payload.message)
        : null
    throw new Error(detail || `Request failed (${response.status}).`)
  }
  return payload as Result
}

function json(input: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }
}

export function createHttpConnectionsService(): ConnectionsService {
  return {
    createService(input) {
      return jsonRequest<IssuedService>("/api/dashboard/services", json(input))
    },
    editService(id, input) {
      return jsonRequest(`/api/dashboard/services/${encodeURIComponent(id)}`, {
        ...json(input),
        method: "PATCH",
      })
    },
    rotateService(id) {
      return jsonRequest(
        `/api/dashboard/services/${encodeURIComponent(id)}/rotate`,
        { method: "POST" }
      )
    },
    async deleteService(id) {
      await jsonRequest(`/api/dashboard/services/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    },
    async revokePhone(id) {
      await jsonRequest(
        `/api/dashboard/devices/${encodeURIComponent(id)}/revoke`,
        { method: "POST" }
      )
    },
    async setClientCardLimit(id, limit) {
      await jsonRequest(`/api/dashboard/credentials/${encodeURIComponent(id)}/card-limit`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit }),
      })
    },
    async revokeClient(id) {
      await jsonRequest(
        `/api/dashboard/credentials/${encodeURIComponent(id)}/revoke`,
        { method: "POST" }
      )
    },
    async revokeHarnessCredential(id) {
      await jsonRequest(
        `/api/dashboard/harness-credentials/${encodeURIComponent(id)}/revoke`,
        { method: "POST" }
      )
    },
    saveServiceLiveActivityPolicy(id, input) {
      return jsonRequest(
        `/api/dashboard/services/${encodeURIComponent(id)}/live-activity-policy`,
        { ...json(input), method: "PUT" }
      )
    },
    resetServiceLiveActivityPolicy(id) {
      return jsonRequest(
        `/api/dashboard/services/${encodeURIComponent(id)}/live-activity-policy`,
        { method: "DELETE" }
      )
    },
    saveClientLiveActivityPolicy(id, input) {
      return jsonRequest(
        `/api/dashboard/credentials/${encodeURIComponent(id)}/live-activity-policy`,
        { ...json(input), method: "PUT" }
      )
    },
    resetClientLiveActivityPolicy(id) {
      return jsonRequest(
        `/api/dashboard/credentials/${encodeURIComponent(id)}/live-activity-policy`,
        { method: "DELETE" }
      )
    },
  }
}
