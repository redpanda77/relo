/**
 * Replaces the server's placeholders with the text a linked browser can open (docs/
 * END-TO-END-ENCRYPTION.md, "Linked browsers"). Walks a parsed Dashboard page: every object marked
 * `encrypted: true` gets its envelope by id, and handles (`p-…`, `t-…`, …) anywhere in the page
 * become the names the opened envelopes carry. Anything that cannot be opened stays locked.
 */
import { rememberNames } from "@/lib/encrypted"

import type { SealedOpener } from "./browser-link"

type Node = Record<string, unknown>

const ENVELOPE_ID = /^(?:ntf|act|ags)_[A-Za-z0-9-]{1,64}$/u
const HANDLE = /\b[ptwca]-[a-z2-7]{16}\b/gu
const FULL_HANDLE = /^[ptwca]-[a-z2-7]{16}$/u
/** Keys whose values are identifiers, links or server-side filter values: never renamed. */
const KEEP_KEYS = /^(?:id|key|href|url|path|route|filterOptions|filters)$|(?:Id|Ids|Href|Url)$/u

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)
const envelopeId = (value: unknown) => (typeof value === "string" && ENVELOPE_ID.test(value) ? value : null)

type Target = { node: Node; candidates: string[] }

function collect(tree: unknown) {
  const targets: Target[] = []
  const sessions: string[] = []
  const walk = (value: unknown, context: string | null) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, context)
      return
    }
    if (!isNode(value)) return
    const own = envelopeId(value.id)
    const notification = envelopeId(value.notificationId)
    const childContext =
      (own?.startsWith("ntf_") ? own : null) ??
      (notification?.startsWith("ntf_") ? notification : null) ??
      (isNode(value.notification) ? envelopeId(value.notification.id) : null) ??
      context
    if (value.encrypted === true) {
      const candidates = [own, notification, childContext].filter((id): id is string => Boolean(id))
      if (candidates.length) targets.push({ node: value, candidates: [...new Set(candidates)] })
    }
    if (own?.startsWith("ags_")) sessions.push(own)
    for (const child of Object.values(value)) walk(child, childContext)
  }
  walk(tree, null)
  return { targets, sessions }
}

/** Handles two envelopes name differently are ambiguous: they keep their handle (review L4). */
function namesIn(content: unknown, into: Map<string, string>, conflicts: Set<string>) {
  if (!isNode(content) || !isNode(content.names)) return
  for (const [handle, name] of Object.entries(content.names)) {
    if (!FULL_HANDLE.test(handle) || !text(name)) continue
    if (into.has(handle) && into.get(handle) !== name) conflicts.add(handle)
    else into.set(handle, name as string)
  }
}

/** The envelope kinds a row id may carry: cards for act_, names for ags_, a notice, question or card for ntf_. */
function kindFits(id: string, envelope: unknown): boolean {
  const kind = isNode(envelope) ? envelope.kind : undefined
  if (id.startsWith("act_")) return kind === "card"
  if (id.startsWith("ags_")) return kind === "names"
  if (id.startsWith("ntf_")) return kind === "notice" || kind === "question" || kind === "card"
  return false
}

function applyContent(node: Node, content: Node) {
  const set = (field: string, ...values: unknown[]) => {
    if (!(field in node)) return
    const value = values.map(text).find(Boolean)
    if (value !== undefined) node[field] = value
  }
  set("title", content.title)
  set("body", content.body, content.summary, content.status)
  set("summary", content.summary, content.status)
  set("prompt", content.summary, content.body)
  set("status", content.status)
  set("detail", content.detail)
  const steps = Array.isArray(content.steps) ? content.steps : null
  if (steps && Array.isArray(node.stepItems)) {
    node.stepItems.forEach((item, index) => {
      if (isNode(item) && text(steps[index])) item.label = steps[index]
    })
  }
  if (steps && isNode(node.steps) && typeof node.steps.current === "string") {
    const match = /^Step (\d+)$/u.exec(node.steps.current)
    const label = match ? text(steps[Number(match[1]) - 1]) : undefined
    if (label) node.steps.current = label
  }
  node.encrypted = false
  node.opened = true
}

function renameHandles(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") return value.replace(HANDLE, (handle) => names.get(handle) ?? handle)
  if (Array.isArray(value)) return value.map((item) => renameHandles(item, names))
  if (!isNode(value)) return value
  for (const [key, child] of Object.entries(value)) {
    if (!KEEP_KEYS.test(key)) value[key] = renameHandles(child, names)
  }
  return value
}

/**
 * Opens what this browser can open in a copy of `tree`. Makes at most one envelope request per
 * 100 ids and none when nothing on the page is sealed.
 */
export async function openSealedTree<T>(tree: T, opener: SealedOpener): Promise<{ tree: T; opened: number; names: Map<string, string> }> {
  const copy = structuredClone(tree)
  const { targets, sessions } = collect(copy)
  const names = new Map<string, string>()
  const ids = [...new Set([...targets.flatMap((target) => target.candidates), ...sessions])]
  if (ids.length === 0) return { tree, opened: 0, names }
  const envelopes = await opener.fetchEnvelopes(ids)
  const contents = new Map<string, Node>()
  const kinds = new Map<string, unknown>()
  await Promise.all(
    Object.entries(envelopes).map(async ([id, envelope]) => {
      if (!ids.includes(id) || !kindFits(id, envelope)) return
      const content = await opener.open(envelope)
      if (isNode(content)) {
        contents.set(id, content)
        kinds.set(id, (envelope as { kind?: unknown }).kind)
      }
    })
  )
  const conflicts = new Set<string>()
  for (const content of contents.values()) namesIn(content, names, conflicts)
  for (const handle of conflicts) names.delete(handle)
  let opened = 0
  for (const target of targets) {
    // A card shows only card text: never a parent notice's or question's text (review L4).
    const card = typeof target.node.id === "string" && target.node.id.startsWith("act_")
    const content = target.candidates.filter((id) => !card || kinds.get(id) === "card").map((id) => contents.get(id)).find(Boolean)
    if (!content) continue
    applyContent(target.node, content)
    opened += 1
  }
  if (opened === 0 && names.size === 0) return { tree, opened, names }
  rememberNames(names)
  return { tree: renameHandles(copy, names) as T, opened, names }
}
