import { Link } from "lucide-react"

import { sourceLogo } from "@/components/atoms/source-logo"
import { SourceMark } from "@/components/atoms/source-mark"

export type OriginParts = {
  source?: string | null
  project?: string | null
  /** Unused: the project is always `--now-violet` (kept so callers need not change). */
  projectColor?: string | null
  /** The session or thread name; shrinks first. */
  topic?: string | null
  /** False when a filter already pins the source (shown anyway when there is no project). */
  showSource?: boolean
  /** The notification carries a link: a small mark after the origin says so ("Has a link"). */
  hasLink?: boolean
}

/**
 * The one origin line: [source tile] project › topic. The source is its logo in an 18px tile (iPhone
 * parity) when it has one, else its name; the project is violet, the topic muted; the topic
 * shrinks first, then the project. Unknown (sealed, unlearned) parts are left out. Used by every
 * card, row and the detail's header.
 */
export function Origin({ source, project, topic, showSource, hasLink }: OriginParts) {
  const name = project?.trim() || null
  const tool = source?.trim() || null
  const shownTool = Boolean(tool) && (showSource !== false || !name)
  const session = topic?.trim() || null
  if (!shownTool && !name && !session) return null
  const spoken = [shownTool ? tool : null, name, session, hasLink ? "Has a link" : null].filter(Boolean).join(", ")
  return (
    <p className="card-origin" aria-label={spoken}>
      {shownTool ? (
        <span className="card-origin-source" data-part="source" data-tile={tool && sourceLogo(tool) ? "" : undefined}>
          {tool ? <SourceMark name={tool} size={11} /> : null}
        </span>
      ) : null}
      {name ? (
        <>
          <span className="card-origin-project" data-part="project">
            {name}
          </span>
        </>
      ) : null}
      {session ? (
        <>
          {shownTool || name ? <span className="card-sep" aria-hidden="true">›</span> : null}
          <span className="card-origin-topic" data-part="topic">{session}</span>
        </>
      ) : null}
      {hasLink ? <Link className="card-origin-link" role="img" aria-label="Has a link" data-part="link" /> : null}
    </p>
  )
}
