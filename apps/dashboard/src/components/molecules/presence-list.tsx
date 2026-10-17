import { AnimatePresence, LazyMotion, m, type TargetAndTransition, type Transition } from "motion/react"
import * as React from "react"

import { DUR, EASE_IN, EASE_OUT, SPRING, STAGGER, STAGGER_CAP, loadMotionFeatures } from "@/lib/motion"
import { cn } from "@/lib/utils"

type ItemAttributes = Record<`data-${string}`, string | undefined>

/** What an item's render knows about its own arrival. */
export type PresenceItemState = {
  /** The item arrived with the latest change of the list (not at the page's first paint). */
  entering: boolean
}

/** The ids that just arrived, in list order, so a burst can stagger in. */
function useEntering(ids: readonly string[], animateFirst: boolean): readonly string[] {
  const key = ids.join("\u0000")
  const [seen, setSeen] = React.useState(() => ({ key, ids: new Set(ids), entering: animateFirst ? [...ids] : ([] as string[]) }))
  if (seen.key !== key) {
    // Adjusting state while rendering (React's sanctioned pattern): no effect, no extra paint.
    setSeen({ key, ids: new Set(ids), entering: ids.filter((id) => !seen.ids.has(id)) })
  }
  return seen.entering
}

// No blur on entry: a filter on an ancestor switches off the glass's backdrop blur until it ends,
// so the frost would flash in. Opacity, a short rise and a hint of scale carry the arrival.
const ENTER_FROM = { opacity: 0, y: 10, scale: 0.985 }
const ENTER_TO = { opacity: 1, y: 0, scale: 1 }
/** Leaves on ease-in at ~0.7x the entrance: a fade and a hint of shrink while the rest close the gap. */
const PRESENCE_EXIT: TargetAndTransition = { opacity: 0, scale: 0.98, transition: { duration: DUR.fast, ease: EASE_IN } }

/** One transition per stagger rank, built once per base delay (never per item per render). */
const transitionCache = new Map<number, Transition[]>()
function transitionsFor(baseDelay: number): Transition[] {
  let cached = transitionCache.get(baseDelay)
  if (!cached) {
    cached = Array.from({ length: STAGGER_CAP + 1 }, (_, rank) => ({
      default: { duration: DUR.base, ease: EASE_OUT, delay: baseDelay + rank * STAGGER },
      layout: SPRING,
    }))
    transitionCache.set(baseDelay, cached)
  }
  return cached
}

type ExitResolver<T> = (item: T) => TargetAndTransition | undefined

/**
 * A list whose items arrive, leave and move instead of popping. The first paint never animates
 * (`initial={false}`; pass `animateFirst` for a list that mounts later, such as a new section's
 * first items): only a refresh's differences do. New items rise in (staggered 40 ms after
 * `enterDelay`, capped at six), removed ones fade and shrink a touch while the rest close the gap,
 * and an item that moves to another list in the same `LayoutGroup` (same `layoutId`) travels there.
 * `exitFor` picks a leaving item's exit from what is known when it leaves (it is read at exit time,
 * not from the item's last render). Only positions animate (`layout="position"`), so text that
 * ticks every second never stretches.
 */
export function PresenceList<T>({
  label,
  items,
  getKey,
  layoutId = getKey,
  className,
  itemClassName,
  itemAttributes,
  animateFirst = false,
  enterDelay = 0,
  exitFor,
  as = "ul",
  children,
}: {
  label: string
  items: readonly T[]
  getKey: (item: T) => string
  /** The id an item keeps across lists, so it morphs from one to the other. Defaults to its key; undefined opts out. */
  layoutId?: (item: T) => string | undefined
  className?: string
  itemClassName?: string
  /** `data-*` attributes for an item's <li> (state hooks for tests and styling). */
  itemAttributes?: (item: T) => ItemAttributes
  /** Animate the items present at mount (a list that appears after the page's first paint). */
  animateFirst?: boolean
  /** Seconds before the first entering item starts (a section's heading goes first). */
  enterDelay?: number
  /** A leaving item's exit; `PRESENCE_EXIT` when it returns nothing. */
  exitFor?: ExitResolver<T>
  /** `div` for lists that are not semantic lists (items render as divs). */
  as?: "ul" | "div"
  children: (item: T, state: PresenceItemState) => React.ReactNode
}) {
  const entering = useEntering(items.map(getKey), animateFirst)
  const transitions = transitionsFor(enterDelay)
  const List = as === "ul" ? m.ul : m.div
  const Item = as === "ul" ? m.li : m.div
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <List aria-label={label} className={cn("relative", className)}>
        {/* `custom` reaches items that are already leaving, so their exit is decided at exit time. */}
        <AnimatePresence initial={animateFirst} mode="popLayout" custom={exitFor}>
          {items.map((item) => {
            const key = getKey(item)
            const rank = entering.indexOf(key)
            return (
              <Item
                key={key}
                layout="position"
                layoutId={layoutId(item)}
                initial={ENTER_FROM}
                animate={ENTER_TO}
                exit="exit"
                variants={{ exit: (resolve?: ExitResolver<T>) => resolve?.(item) ?? PRESENCE_EXIT }}
                transition={transitions[Math.min(Math.max(rank, 0), STAGGER_CAP)]}
                className={itemClassName}
                {...itemAttributes?.(item)}
              >
                {children(item, { entering: rank >= 0 })}
              </Item>
            )
          })}
        </AnimatePresence>
      </List>
    </LazyMotion>
  )
}
