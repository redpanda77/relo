import * as React from "react"

import { PresenceList, type PresenceItemState } from "@/components/molecules/presence-list"
import { cn } from "@/lib/utils"
import type { DataAttributes } from "@/components/card/card"

const LIST_CLASS = "card-list glass"

/** A static list item for `<CardList>` with node children. */
export function CardListItem(props: React.ComponentProps<"li">) {
  return <li {...props} />
}

/**
 * One glass list of rows: dividers inset by the card padding, never a card inside a card. With
 * `items` it is a PresenceList (rows arrive, leave and travel); with node children, a static <ul>.
 */
export function CardList<T>(
  props:
    | {
        label: string
        className?: string
        items?: undefined
        children: React.ReactNode
      }
    | {
        label: string
        className?: string
        items: readonly T[]
        getKey: (item: T) => string
        layoutId?: (item: T) => string | undefined
        itemAttributes?: (item: T) => DataAttributes
        animateFirst?: boolean
        enterDelay?: number
        exitFor?: React.ComponentProps<typeof PresenceList<T>>["exitFor"]
        children: (item: T, state: PresenceItemState) => React.ReactNode
      }
) {
  if (props.items === undefined) {
    return (
      <ul aria-label={props.label} className={cn(LIST_CLASS, props.className)}>
        {props.children}
      </ul>
    )
  }
  const { label, className, items, getKey, layoutId, itemAttributes, animateFirst, enterDelay, exitFor, children } = props
  return (
    <PresenceList
      label={label}
      items={items}
      getKey={getKey}
      layoutId={layoutId}
      itemAttributes={itemAttributes}
      animateFirst={animateFirst}
      enterDelay={enterDelay}
      exitFor={exitFor}
      className={cn(LIST_CLASS, className)}
    >
      {children}
    </PresenceList>
  )
}
