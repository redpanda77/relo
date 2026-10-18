import { SourceMark } from "@/components/atoms/source-mark"

export type OriginParts = {
  source?: string | null
  project?: string | null
  /** The project's palette colour (lib/project-palette.ts). */
  projectColor?: string | null
  /** The session or thread name; shrinks first. */
  topic?: string | null
  /** False when a filter already pins the source (shown anyway when there is no project). */
  showSource?: boolean
}

/**
 * The one origin line: source · project › topic. The source is its logo when it has one; the topic
 * shrinks first, then the project. Unknown (sealed, unlearned) parts are left out. Used by every
 * card, row and the detail's header.
 */
export function Origin({ source, project, projectColor, topic, showSource }: OriginParts) {
  const name = project?.trim() || null
  const tool = source?.trim() || null
  const shownTool = Boolean(tool) && (showSource !== false || !name)
  const session = topic?.trim() || null
  if (!shownTool && !name && !session) return null
  const spoken = [shownTool ? tool : null, name, session].filter(Boolean).join(", ")
  return (
    <p className="card-origin" aria-label={spoken}>
      {shownTool ? <span className="card-origin-source" data-part="source">{tool ? <SourceMark name={tool} /> : null}</span> : null}
      {name ? (
        <>
          {shownTool ? <span className="card-sep" aria-hidden="true">·</span> : null}
          <span className="card-origin-project" data-part="project" style={projectColor ? { color: projectColor } : undefined}>
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
    </p>
  )
}
