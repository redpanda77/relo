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

## Landing and sign-in

- **`/` for a signed-out visitor to a claimed server** is the landing page (`features/landing`). An unclaimed server, or any `?next=` return path, goes straight to the form; the form lives at `/sign-in` and every sign-in redirect points there.
- The landing leads with the value proposition ([docs/VALUE-PROPOSITION.md](../../docs/VALUE-PROPOSITION.md)): the hero subtitle names agents, scripts and apps wherever they run, and the section right under it (`#one-place`) shows sources (laptop, another computer, home server or cloud, your app) converging on Relo and the four things the owner gets (live status, time-sensitive alerts, details, input). Plans, sessions and hooks come later, as supporting features.
- The landing hero is one three.js scene (`landing-scene.ts`, with a bloom pass): the plasma core in the meaning colours, instrument rings, and agent signals streaming in as comets that ripple the core. It loads in its own chunk after first paint, compiles its shaders asynchronously, pauses off screen, renders one still frame under reduced motion, and falls back to a painted orb without WebGL. Colours go through `THREE.Color` (linear), and the background is `scene.background`, never a raw clear colour, so nothing is encoded twice.
- GSAP (`landing-motion.ts`) only reveals and loops: section titles rise by line, blocks lift in once, and the three demos (the live Lock Screen card, the `relo ask` terminal with its approve card, the sealed-to-plain privacy cards) play while visible. Scrolling stays native; nothing is pinned or scrubbed into a story.
- Comets end just outside the orb's displaced surface and aim at its visible face; each impact ripple is placed in the spinning orb's own frame so it starts where the comet hit.
- GSAP never owns a property something else owns: entrances move the CTA row (magnetic hover moves the buttons), and the chip float uses yPercent (the entrance uses y). Landing-only rules are unlayered, so they beat Tailwind utilities: never pair a landing class that sets `display` with `hidden`/`md:hidden`.
- A "Pause motion" control in the nav stops GSAP, the scene and CSS loops. An error boundary keeps a plain page if the chunk or motion fails, and hidden reveals are forced visible in print.
- The sign-in page shows no server row (the address bar already says it) and fits one phone screen: a 200px deck, 150px on short screens.
- Landing sections have no kicker above the title: the title is enough.
- Rising text: every line mask (hero `.landing-line`, SplitText `.split-line-mask`) is padded 0.2em below and offset by a negative margin, so descenders fit; lines start at yPercent 130. After the entrance the hero masks stop clipping and section titles revert their split, so text at rest is plain.
- Load path: the server reads Vite's manifest (`dist/.vite/manifest.json`) and lists the landing chunk, its CSS and imports (and the scene at low priority) in the landing document, so they download with the entry instead of one round trip after another. The hero copy animates in at once and never waits for WebGL.
- Below 1024px the core takes the top band and the copy follows beneath it. Phones (below 720px, the "Phones" block in `landing.css`) get their own layouts rather than stacked desktop ones: the `#one-place` sources and outcomes become 2×2 tiles around the hub; Stay in control shows a smaller phone and tighter question rows; privacy becomes a timeline down the screen instead of four boxes; the feature cards become a swipeable row that snaps and peeks the next card. The floating hero chips appear only on wide screens (1280px and up).
- The sign-in page on desktop is the deck alone at a 600px stage (`NowHud stage`), drawn natively rather than scaled, beside the card; phones keep the compact deck with the headline.
- Both pages link to the public GitHub repository (`features/auth/github.tsx`); the sign-in page returns to the landing through the logo.

## E2EE display rules (behaviour, not style)

- Handles (`p-…`, `t-…`, `c-…`, `a-…`, `w-…`) always render through `displayName()`.
- Unopened encrypted items show "End-to-end encrypted · open on iPhone to read".
- The linked-browser QR stays large and unclipped.
- Pending devices are read-only in the browser.
