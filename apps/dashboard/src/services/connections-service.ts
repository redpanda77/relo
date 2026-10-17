import type { ComputerRename } from "@relo/notification-contracts"

import type { ConnectionComputer, ConnectionService, LoginScope, ServiceScope } from "@/features/connections/types"
import type {
  PresentationPolicy,
  PresentationPolicySource,
} from "@/features/presentation-policy/types"

export type ServiceDefaults = {
  title: string
  imageUrl: string | null
  destinationUrl: string | null
}

/** What a service may do (at least one scope) and whether it may send readable content on an encrypted account. */
export type ServiceAccess = {
  readableAllowed: boolean
  scopes: ServiceScope[]
}

/** One PATCH for a service: its defaults always, its access only when it changed. */
export type ServiceEdit = ServiceDefaults & Partial<ServiceAccess>

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
        | "readableAllowed"
        | "scopes"
      >
    >
  /** Where the service sends (`<origin>/hooks`); not secret. */
  endpoint: string
  /** Sent as `Authorization: Bearer hook_…`; shown once. */
  secret: string
}

/** A CI token as the owner makes it: a name, what it may do (every login scope when omitted) and its lifetime. */
export type CiTokenInput = {
  name: string
  scopes?: LoginScope[]
  expiresInDays: number
}

/** The server's answer: the token (shown once) and the credential as lists show it. */
export type IssuedCiToken = {
  token: string
  credential: {
    id: string
    name: string
    prefix: string
    scopes: string[]
    createdAt: string
    expiresAt: string
    lastUsedAt: string | null
  }
}

export interface ConnectionsService {
  createCiToken(input: CiTokenInput): Promise<IssuedCiToken>
  revokeCiToken(id: string): Promise<void>
  createService(input: ServiceDefaults): Promise<IssuedService>
  editService(
    id: string,
    input: ServiceEdit
  ): Promise<{
    service: Pick<
      ConnectionService,
      "id" | "title" | "prefix" | "imageUrl" | "destinationUrl"
    > &
      ServiceAccess
  }>
  rotateService(id: string): Promise<IssuedService>
  deleteService(id: string): Promise<void>
  revokePhone(id: string): Promise<void>
  /** Rename a computer and/or set its icon (`null` clears: the login's name, the automatic icon). */
  updateComputer(id: string, input: ComputerRename): Promise<ConnectionComputer>
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
    createCiToken(input) {
      return jsonRequest<IssuedCiToken>("/api/dashboard/ci-tokens", json(input))
    },
    async revokeCiToken(id) {
      // A CI token is a login: it is revoked as one.
      await jsonRequest(
        `/api/dashboard/credentials/${encodeURIComponent(id)}/revoke`,
        { method: "POST" }
      )
    },
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
    updateComputer(id, input) {
      return jsonRequest<ConnectionComputer>(`/api/dashboard/computers/${encodeURIComponent(id)}`, {
        ...json(input),
        method: "PATCH",
      })
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
