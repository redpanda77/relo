// `.contentTransition(.numericText(value:))` (ReloSummaryCount, ReloSectionHeader): a number whose digits roll when it
// changes. Only the digits that differ move (the rest hold still); counting up rolls them up, counting down rolls them
// down, each one fading and blurring as it passes. The old digit leaves without taking room, so the line around it is
// never cut: its siblings glide to the new width on their own layout spring.

import { AnimatePresence, motion } from "motion/react"
import { useRef, type CSSProperties } from "react"
import { SPRINGS } from "./tokens"

/** How far a digit travels, in pt, and how soft it gets on the way. */
export const ROLL = { distance: 7, blur: 2 } as const

/** The digits of `value`, each keyed by its place from the right and its glyph: unchanged places keep their key and do not move. */
export function digitsOf(value: number | string): Array<{ key: string; char: string }> {
  const chars = String(value).split("")
  return chars.map((char, index) => ({ key: `${chars.length - index}:${char}`, char }))
}

/** +1 when the number went up (digits roll up), -1 when it went down. */
export function rollDirection(from: number, to: number): 1 | -1 {
  return to >= from ? 1 : -1
}

const variants = {
  enter: (dir: number) => ({ opacity: 0, y: dir * ROLL.distance, filter: `blur(${ROLL.blur}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (dir: number) => ({ opacity: 0, y: -dir * ROLL.distance, filter: `blur(${ROLL.blur}px)` }),
}

export function NumericText({ value, reduceMotion = false, className, style }: { value: number; reduceMotion?: boolean; className?: string; style?: CSSProperties }) {
  const last = useRef(value)
  const direction = rollDirection(last.current, value)
  last.current = value
  return (
    <span className={className} style={{ position: "relative", display: "inline-flex", ...style }} aria-label={String(value)}>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        {digitsOf(value).map(({ key, char }) => (
          <motion.span
            key={key}
            custom={direction}
            variants={reduceMotion ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } } : variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={SPRINGS.snappy}
            style={{ display: "inline-block" }}
            aria-hidden
          >
            {char}
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  )
}
