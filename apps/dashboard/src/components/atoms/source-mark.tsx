import { sourceLogo } from "@/components/atoms/source-logo"
import { cn } from "@/lib/utils"

/**
 * A known agent's own mark in place of its name (iOS SourceLogo): "Claude Code" reads as the Claude
 * Code mascot. Unknown sources keep their name. Marks: Lobe Icons (MIT), drawn in the brand colour
 * where it has one, else in the surrounding text colour.
 */
/** The source as its logo when known (its name stays for assistive technology), else as its name. */
export function SourceMark({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const logo = sourceLogo(name)
  if (!logo) return <>{name}</>
  return (
    <>
      <svg
        aria-hidden="true"
        className={cn("source-mark", className)}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        fillRule="evenodd"
        style={logo.tint ? { color: logo.tint } : undefined}
      >
        <path clipRule="evenodd" d={logo.path} />
      </svg>
      <span className="sr-only">{logo.name}</span>
    </>
  )
}
