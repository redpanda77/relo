# Relo web design system

The iPhone app is the reference. The web dashboard and the pages the server renders (iPhone sign-in, CLI authorization, 404/500) are the app's larger window. They use the same canvas, glass, type, meaning colours and orb. Tokens live in `src/index.css`. The server pages mirror them in `apps/server/src/web/public-page.ts`, so a change in one needs the same change in the other.

## Canvas and colour

| Role | Value | iOS name |
|---|---|---|
| Canvas | `#08080d` | `reloCanvas` |
| Solid surface (overlays; increased-contrast fallback) | `#111119` | `reloSurface` |
| Text / muted text | `#f3f3f7` / `#a4a4b6` | `reloSecondaryText` |
| Links, tint, focus accents | coral `#ff6b57` | `reloCoral` |
| Filled actions (white text, at least 4.5:1) | `#c8432f`, hover `#d4513b` | `reloActionFill` |
| Errors | `#f87171` | `reloErrorText` |

- **Backdrop.** Three static glows over the canvas, painted on a fixed `body::before` layer because iOS Safari ignores `background-attachment: fixed`:
  - magenta 30% at the top right
  - indigo 26% at the top left
  - coral 18% at the bottom
- **Meaning colours.** These follow the HUD palette everywhere: done mint `#34d399`, running cyan `#5ce1ff`, needs-you orange `#ff8a3d`, attention yellow `#facc15`, failed red `#f43f5e`, message violet `#8b7cff`. Never introduce another blue, amber or green for state.

## Surfaces

- **Glass card** (`.glass`, `Card`):
  - fill: white 4%, plus a white-3.5% wash fading out by the middle
  - border: 1px white 8%
  - inset highlight on the top edge, and shadow `0 12px 24px rgb(0 0 0 / .45)`
  - radius 20px
  - increased contrast or reduced transparency falls back to solid `#111119` with a white-24% border
- **Lists.** Frosted lists use `List` / `Row`: one glass container with hairline dividers. Never put cards inside cards.
- **Blur order.** Write `-webkit-backdrop-filter` before `backdrop-filter` in every rule. Lightning CSS keeps only the last declaration, so the reverse order loses the frost in Chrome.
- **Holo cards** (`.holo-card`) are reserved for activity: ink→tone gradient, a lit top line, radius 20.
- **Radii:**
  - 20 cards
  - 28 the sign-in card
  - 14 inputs and rows
  - 8 icon tiles and chips
  - capsules for pills and primary CTAs

## Type

- **Body:** SF on Apple devices (`-apple-system`), Inter Variable elsewhere.
- **Numerals and wordmark:** SF Rounded (`--font-rounded`, `.numeral`, `.wordmark`). The wordmark is always lowercase `relo`.
- **Titles:** page titles are bold, 32–38px, tracking tight, as iOS large titles. A one-line muted description may follow; there is no kicker above the title.
- **Instrument labels** (`.micro`): mono, 10.5px, semibold, uppercase, tracking .16em. Use them for section captions, HUD labels and telemetry only.

## Components

- `BrandOrb` / `BrandLockup` (`components/brand.tsx`) are the only logo. There is no bell icon and no uppercase RELO.
- `NowHud` is the living deck. `welcome` mode drops the numbers and shows the wordmark (the signed-out Welcome stage).
- Buttons:
  - `Button` default is the coral action fill.
  - `outline` is neutral glass.
  - `.capsule-cta` is the 52px hero action, with an occasional shimmer.
- `.pill` is used for filters and secondary links. It works as a toggle (`aria-pressed`) or as a styled `select`. Pill rows scroll sideways on phones (`.no-scrollbar`).
- `.icon-tile` is the Settings-style gradient tile; colour it with a `.tone-*` class.
- `Empty`: orb, title, one sentence. `RouteLoadingFallback`: title and list skeleton with `.skeleton` shimmer.

## Navigation

- **Desktop:** a sidebar with Now, History, Projects, Connections and Test Lab, then a "Settings" group with Account and Documentation, then the profile menu.
- **Phones:** no top bar; the page title sits under the safe area, as on iOS. A bottom tab bar (`.tab-bar`) holds Now, History, Projects, Connections and More, and More opens the sidebar sheet.
- The needs-you count is an orange badge on Now.

## Motion

- One entrance: `.rise-in`, which rises 14px and unblurs from an already-legible start, staggered by 60ms.
- The deck's ambient motion belongs to `NowHud`.
- Everything stops under `prefers-reduced-motion`.

## E2EE display rules (behaviour, not style)

- Handles (`p-…`, `t-…`, `c-…`, `a-…`, `w-…`) always render through `displayName()`.
- Unopened encrypted items show "End-to-end encrypted · open on iPhone to read".
- The linked-browser QR stays large and unclipped.
- Pending devices are read-only in the browser.
