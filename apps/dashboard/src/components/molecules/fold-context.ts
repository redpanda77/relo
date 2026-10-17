import * as React from "react"

/**
 * Whether the fold around a list is open (true outside any fold). A list in a closed fold passes no
 * shared layout id, so an item moving into it leaves toward the summary instead of morphing into a
 * box nobody can see.
 */
export const FoldOpenContext = React.createContext(true)
