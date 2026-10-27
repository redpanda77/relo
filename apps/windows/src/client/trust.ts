// Which computers this PC believes (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once"): the Dashboard's
// BrowserLink rules for a linked browser, for a device that reads the same lists with its device bearer
// (GET /api/clients/keys, GET /api/devices/self/approvers).
//   - Computers listed at this PC's first contact are trusted (first use).
//   - A computer that signs in later is held until an approver this PC pinned signed its current key.
//   - An approver is pinned at first contact, or later only when an approver already pinned vouched for it.
// What a held computer sealed stays locked here, shown as "Approve this PC on your iPhone".
// This PC signs approvals (ownerCrypto.approveComputer / syncApprovals) for computers it trusts or the owner approves.

import { approveComputerSigningInput, approveDeviceSigningInput, b64u, fromB64u, keyId, linkSigningInput, verifyBytes, type Bytes, type KeyValueStore } from "@relo/owner-crypto"

type Level = "auto" | "pending" | "declined"
interface TrustedClient { keyId: string; publicKey: string; name: string; level: Level; approvedBy?: string }
interface PinnedApprover { id: string; name: string; identityKey: string }
interface ListedApproval { approverId: string; signedAt: string; signature: string }
interface ListedComputer { clientId: string; keyId: string; publicKey: string; name: string; approvals: ListedApproval[] }
interface ListedApprover {
  id: string
  name: string
  identityKey: string
  vouchedBy: { approverId: string; signedAt: string; signature: string; statement: string } | null
}

/** A browser's link counts this long after the phone signed it (the CLI's LINK_DAYS). */
const LINK_LIFETIME_MS = 14 * 86_400_000
/** The lists are read at most this often. */
const REFRESH_MS = 60_000

/** A computer of the account as this PC last read it. */
export interface ComputerRow {
  clientId: string
  keyId: string
  publicKey: string
  name: string
  level: Level
  /** This PC already signed an approval of this key. */
  signedByThisPc: boolean
}

export interface TrustDeps {
  store: KeyValueStore
  /** Scope for the stored lists (the account id). */
  scope: string
  /** GET a server path with the device bearer; null when it failed (offline, older server). */
  getJson(path: string): Promise<Record<string, unknown> | null>
  /** This device, pinned as an approver of itself. */
  self(): { id: string; identityKey: string } | null
  now(): number
}

async function verifies(publicKey: string, message: Bytes, signature: string): Promise<boolean> {
  try {
    return await verifyBytes(fromB64u(publicKey, { length: 65 }), message, fromB64u(signature, { length: 64 }))
  } catch {
    return false
  }
}

export class Trust {
  private cached: { at: number; senders: Map<string, Bytes> } | null = null
  private refreshing: Promise<Map<string, Bytes>> | null = null
  private rows: ComputerRow[] = []

  private readonly deps: TrustDeps

  constructor(deps: TrustDeps) {
    this.deps = deps
  }

  get storageKeys(): string[] {
    return [`clients:${this.deps.scope}`, `approvers:${this.deps.scope}`]
  }

  /** key id -> public key of every computer this PC opens text from. */
  async trustedSenders(): Promise<Map<string, Bytes>> {
    if (this.cached && this.deps.now() - this.cached.at < REFRESH_MS) return this.cached.senders
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** Reads the lists now (not at most once a minute) and returns every computer with the trust this PC gives it. */
  async computers(): Promise<ComputerRow[]> {
    this.cached = null
    await this.trustedSenders()
    return this.rows
  }

  /** The owner decided on a computer here: its current key is trusted ("auto") or declined. */
  async decide(clientId: string, level: "auto" | "declined"): Promise<void> {
    const key = this.storageKeys[0]!
    const clients = (await this.deps.store.get<Record<string, TrustedClient>>(key)) ?? {}
    const known = clients[clientId]
    if (!known) return
    await this.deps.store.set(key, { ...clients, [clientId]: { ...known, level, ...(level === "auto" ? { approvedBy: "This PC" } : {}) } })
    this.cached = null
    this.rows = this.rows.map((row) => (row.clientId === clientId ? { ...row, level } : row))
  }

  /** Computers waiting for an approver's signature. */
  async pending(): Promise<string[]> {
    const clients = (await this.deps.store.get<Record<string, TrustedClient>>(this.storageKeys[0]!)) ?? {}
    return Object.values(clients).filter((client) => client.level === "pending").map((client) => client.name)
  }

  private async refresh(): Promise<Map<string, Bytes>> {
    const clients = await this.read()
    const senders = new Map<string, Bytes>()
    for (const client of Object.values(clients)) {
      if (client.level !== "auto") continue
      try {
        senders.set(client.keyId, fromB64u(client.publicKey, { length: 65 }))
      } catch {
        // A malformed key opens nothing.
      }
    }
    this.cached = { at: this.deps.now(), senders }
    return senders
  }

  private async read(): Promise<Record<string, TrustedClient>> {
    const clientsKey = this.storageKeys[0]!
    const remembered = (await this.deps.store.get<Record<string, TrustedClient>>(clientsKey)) ?? {}
    let listed: ListedComputer[]
    let approvers: ListedApprover[]
    try {
      const [clients, approverList] = await Promise.all([this.deps.getJson("/api/clients/keys"), this.deps.getJson("/api/devices/self/approvers")])
      if (!Array.isArray(clients?.clients)) return remembered
      listed = (clients.clients as Array<Record<string, unknown>>).flatMap((client) =>
        typeof client.clientId === "string" && typeof client.keyId === "string" && typeof client.publicKey === "string"
          ? [{
              clientId: client.clientId,
              keyId: client.keyId,
              publicKey: client.publicKey,
              name: typeof client.name === "string" ? client.name : client.clientId,
              approvals: Array.isArray(client.approvals) ? (client.approvals as ListedApproval[]) : [],
            }]
          : [],
      )
      approvers = Array.isArray(approverList?.approvers) ? (approverList.approvers as ListedApprover[]) : []
    } catch {
      return remembered
    }
    const pinned = await this.pinApprovers(approvers)
    const firstContact = Object.keys(remembered).length === 0
    const next = { ...remembered }
    for (const client of listed) {
      let publicKey: Bytes
      try {
        publicKey = fromB64u(client.publicKey, { length: 65 })
      } catch {
        continue
      }
      if ((await keyId(publicKey)) !== client.keyId) continue
      let approvedBy: string | undefined
      for (const approval of client.approvals) {
        const key = pinned.get(approval.approverId)
        const message = approveComputerSigningInput({ clientId: client.clientId, identityKey: client.publicKey, approverId: approval.approverId, signedAt: approval.signedAt })
        if (key && (await verifies(b64u(key), message, approval.signature))) {
          approvedBy = approvers.find((approver) => approver.id === approval.approverId)?.name ?? approval.approverId
          break
        }
      }
      const known = remembered[client.clientId]
      if (known && known.publicKey === client.publicKey) {
        if (known.level === "pending" && approvedBy) next[client.clientId] = { ...known, level: "auto", approvedBy }
        continue
      }
      const knownTrusted = known ? known.level === "auto" : false
      const level: Level = known?.level === "declined" ? "declined" : knownTrusted || (!known && firstContact) || approvedBy ? "auto" : "pending"
      next[client.clientId] = { keyId: client.keyId, publicKey: client.publicKey, name: client.name, level, ...(approvedBy ? { approvedBy } : {}) }
    }
    await this.deps.store.set(clientsKey, next)
    const self = this.deps.self()?.id
    this.rows = listed.flatMap((client) => {
      const trusted = next[client.clientId]
      return trusted ? [{ clientId: client.clientId, keyId: client.keyId, publicKey: client.publicKey, name: trusted.name, level: trusted.level, signedByThisPc: client.approvals.some((a) => a.approverId === self) }] : []
    })
    return next
  }

  private async pinApprovers(listed: ListedApprover[]): Promise<Map<string, Bytes>> {
    const storeKey = this.storageKeys[1]!
    let pinned = (await this.deps.store.get<PinnedApprover[]>(storeKey)) ?? []
    const before = JSON.stringify(pinned)
    if (pinned.length === 0) {
      pinned = listed.map(({ id, name, identityKey }) => ({ id, name, identityKey }))
    } else {
      for (let grew = true; grew; ) {
        grew = false
        for (const approver of listed) {
          if (pinned.some((entry) => entry.id === approver.id && entry.identityKey === approver.identityKey)) continue
          const voucher = approver.vouchedBy
          const by = voucher ? pinned.find((entry) => entry.id === voucher.approverId) : undefined
          if (!voucher || !by || voucher.approverId === approver.id) continue
          if (voucher.statement === "link" && !(this.deps.now() - Date.parse(voucher.signedAt) < LINK_LIFETIME_MS)) continue
          const message =
            voucher.statement === "approve-device"
              ? approveDeviceSigningInput({ deviceId: approver.id, identityKey: approver.identityKey, approverDeviceId: voucher.approverId, signedAt: voucher.signedAt })
              : voucher.statement === "link"
                ? linkSigningInput({ browserId: approver.id, identityKey: approver.identityKey, phoneDeviceId: voucher.approverId, signedAt: voucher.signedAt })
                : null
          if (!message || !(await verifies(by.identityKey, message, voucher.signature))) continue
          pinned = [...pinned.filter((entry) => entry.id !== approver.id), { id: approver.id, name: approver.name, identityKey: approver.identityKey }]
          grew = true
        }
      }
    }
    const self = this.deps.self()
    if (self && !pinned.some((entry) => entry.id === self.id && entry.identityKey === self.identityKey)) {
      pinned = [...pinned.filter((entry) => entry.id !== self.id), { id: self.id, name: "This PC", identityKey: self.identityKey }]
    }
    if (JSON.stringify(pinned) !== before) await this.deps.store.set(storeKey, pinned)
    const keys = new Map<string, Bytes>()
    for (const entry of pinned) {
      try {
        keys.set(entry.id, fromB64u(entry.identityKey, { length: 65 }))
      } catch {
        // A malformed pin opens nothing.
      }
    }
    return keys
  }
}
