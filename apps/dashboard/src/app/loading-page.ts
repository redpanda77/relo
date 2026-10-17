/** Which skeleton a page wears while its code loads (mirrors the server's `skeletonKindFor`). */
export type SkeletonKind = "now" | "list" | "detail"

export function skeletonKindFor(kind: string): SkeletonKind {
  if (kind === "inbox-overview") return "now"
  if (kind === "notification-detail") return "detail"
  return "list"
}

/** The page about to show: the router sets it before committing, so the fallback wears its shape. */
let pending: { kind: SkeletonKind; title: string } = { kind: "list", title: "" }

export function setLoadingPage(kind: string, title = "") {
  pending = { kind: skeletonKindFor(kind), title }
}

/** The page the fallback should wear right now. */
export function loadingPage() {
  return pending
}
