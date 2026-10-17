# Relo web design system

The iPhone app is the reference. The web dashboard and the pages the server renders (iPhone sign-in, CLI authorization, 404/500) are the app's larger window. They use the same canvas, materials, type, meaning colours and orb. Tokens live in `src/index.css`. The server pages mirror them in `apps/server/src/web/public-page.ts`, so a change in one needs the same change in the other.

## Canvas and colour

| Role | Value | iOS name |
|---|---|---|
| Canvas | `#08080d` | `reloCanvas` |
| Solid surface (overlays; increased-contrast fallback) | `#111119` | `reloSurface` |
| Text / muted text | `#f3f3f7` / `#a4a4b6` | `reloSecondaryText` |
| Links, tint, the current page's icon and tab | coral `#ff6b57` | `reloCoral` |
| Primary action (solid light, ink text) | `#f3f3f7`, hover `#ffffff`, ink `#0b0b12` | |
| The landing's coral capsule (white text, at least 4.5:1) | `#c8432f`, hover `#d4513b` | `reloActionFill` |
| Focus ring | violet `#a796ff` | |
| Errors | `#f87171` | `reloErrorText` |

- **Backdrop.** Three static glows over the canvas, painted on a fixed `body::before` layer because iOS Safari ignores `background-attachment: fixed`:
  - magenta 22% at the top right
  - indigo 20% at the top left
  - coral 12% at the bottom

  They are quiet on purpose: surfaces read as one material over the field, never tinted by it.
- **Meaning colours.** These follow the HUD palette everywhere: done mint `#34d399`, running cyan `#5ce1ff`, needs-you orange `#ff8a3d`, attention yellow `#facc15`, failed red `#f43f5e`, message violet `#8b7cff`. Never introduce another blue, amber or green for state.

## Surfaces

Two materials, no more. Tone is information, never decoration: no surface carries a gradient, a tone-tinted corner or a coloured glow. Tokens: `--sheet-*`, `--raised-*`, `--control-*`, `--primary-*`, `--hairline`, `--divider` in `src/index.css`.

- **Sheet** (`.glass`, `Card`, `List`, Now's folds, project tiles, notices): the one material for content.
  - fill: white 4% (`--sheet-fill`), flat
  - border: 1px white 8% (`--sheet-border`)
  - the lit top edge `inset 0 1px 0` white 5%, and one resting shadow `0 16px 32px -20px` black 80%
  - backdrop blur 24px, saturate 120%
  - radius 20
- **Raised** (`.glass-strong`, sheets, dialogs, menus, the More sheet; the sidebar is its chrome cousin): what floats over the page.
  - fill `rgb(17 17 25 / .94)`, border white 10%, shadow `0 24px 56px -16px` black 75%, blur 16px
  - the sidebar is ink 78% with the sheet's border and edge
- **Lines:** `--hairline` (white 8%) borders surfaces and quiet controls; `--divider` (white 6%) separates rows; `--hairline-strong` (white 16%) is the hover and chosen line. No other opacities.
- **Inner boxes** (a code block, a facts list, a choice card inside a card): radius 14, hairline, white 3%. Never a sheet inside a sheet.
- **Tone on a surface** is only ever: a toned hairline (needs-you cards 30%, notices 22%, the pending question 26%) and an even whisper of fill (5–6%). The chip, the glyph and the words carry the meaning.
- **Lists.** Frosted lists use `List` / `Row`: one sheet with dividers inset 16px. Never put cards inside cards.
- **Blur order.** Write `-webkit-backdrop-filter` before `backdrop-filter` in every rule. Lightning CSS keeps only the last declaration, so the reverse order loses the frost in Chrome.
- **Reduced transparency or more contrast:** blur goes to 0 and every material becomes solid `#111119` with a white-24% border; toned surfaces keep 6% of their tone on it.
- **Radii:**
  - 20 cards and sheets
  - 28 the sign-in card
  - 14 rows and inner boxes (`rounded-xl`)
  - 12 / 10 / 8 for 44 / 36 / 32px controls (`rounded-lg` is 10)
  - 8 icon tiles
  - capsules for pills, chips and the 52px hero action

## Type

- **Body:** SF on Apple devices (`-apple-system`), Inter Variable elsewhere.
- **Numerals and wordmark:** SF Rounded (`--font-rounded`, `.numeral`, `.wordmark`). The wordmark is always lowercase `relo`.
- **Titles:** page titles are bold, 32–38px, tracking tight, as iOS large titles. A one-line muted description may follow; there is no kicker above the title.
- **Instrument labels** (`.micro`): mono, 10.5px, semibold, uppercase, tracking .16em. Use them for section captions, HUD labels and telemetry only (the iPhone's Now captions). Never on a button, a chip or a form label.
- **Controls** speak plainly: medium weight, sentence case, 13px at 32px, 14px at 36px, 15px at 44px. Muted text is `#a4a4b6` (above 7:1 on the canvas); nothing that must be read goes lower.

## Page rhythm

- One gutter and one top inset for every route (`--page-gutter` 20/32/40px, `--page-top` 24/32/40px at phone, 640px and 1024px) and one gap between sections (`--section-gap`, 40px). `PageTitle` is the only page title, so titles sit in the same place on every page.
- `Page` is the standard frame: title row, then a stack. `SplitPage` is the iPhone's landscape layout for a wide window: a still aside (the Now deck) and the content scrolling beside it. It is judged by the page's own width (a container query at 940px), so collapsing the sidebar can flip it; with less room the aside leads and the content follows, as in portrait.

## Components

Atomic layers under `src/components`: atoms (`Readout`, `SignalGlyph`, `StepTrack`, `StatusDot`, `EncryptedText`), molecules (`SpectrumBar`, `SyncStatus`, `Fold`, `DeliveryChain`), organisms (`OrbStage`, `NowDeck`, `NotificationPreview`, `RunMonitor`), and the templates in `page.tsx` (`Page`, `SplitPage`, `Section`, `List`, `Row`). Features compose them; a new piece goes in the lowest layer that holds it.

- `BrandOrb` / `BrandLockup` (`components/brand.tsx`) are the only logo. There is no bell icon and no uppercase RELO.
- **The Relo core** is one three.js scene (`lib/orb-scene.ts`) in two framings: `hero` for the landing and `deck` for everything else. `OrbStage` puts the deck framing in a box: it loads the scene in its own chunk after first paint, shows a painted orb in the same colours until it is ready (and without WebGL), pauses off screen and in hidden tabs, holds one still frame under reduced motion, ripples the plasma where it is touched, and feathers its edges into the page. Children sit over the core's centre on a soft ink well.
- `NowDeck` is Now's living deck: the title and sync status, the core with its count, then four readouts and today's spectrum. The core is driven by the day (`lib/orb-theme.ts`): each state paints an analogous ramp (clear mint-teal-violet, running the landing's cyan-violet-magenta, needs you orange-coral-magenta) with today's biggest other meaning on the brightest peaks; comets fly at the pace of live work (two when idle) in today's colours; new activity sends one in; each running task's progress glows on the inner ring.
- The sign-in page wears the same core with the wordmark in place of the count.
- **State** is the meaning palette only: `--status-*` are aliases of the neon meanings and `toneFor(state)` (`lib/status-tone.ts`) is the single state-to-tone map. State shows as `StatusChip` (a 20px capsule: soft is the tone at 12% behind its word, hairline is a 30% tone outline) or `StatusDot` (a dot with its word, breathing when live); `Badge` is for counts and labels only (quiet control fill, or a hairline outline).
- **Heights:** controls come in 32 (compact: pills, small buttons, segments), 36 (default buttons, inputs, selects) and 44 (large buttons); everything grows to 44 on touch screens on its own.
- **Shared pieces:** rows lead with `IconTile` (30 or 36px); inline messages are `Notice` (tinted, or quiet inside a card); action feedback is `OperationStatus`; labelled facts are `FactList`; confirmations are `ConfirmationAction`. `Section` takes an optional count, meaning colour and description (long prose goes in the description, never the action slot); `Row` takes `status`, `description`, `actions` and `wrap`. Prose is capped at 65ch. Settings pages put a sticky section index beside the content from 1024px; lists of equal items become a tile grid from 1280px.
- **History** is a log, not a wall of cards. Each day is a group (a header line on phones, a still rail on the left on wide pages). Settled items are one frosted list of 60px rows: a `SignalGlyph`, the title, then one line (the outcome word in its colour, then the summary), the time on the right; identity (source · project › topic) sits under the title on phones and in its own column with the kind on wide pages. Only live work keeps a card, placed where it falls in time. Filters are one toolbar row under the heading (kind pills, project and state, Clear, Delivery log), scrolling sideways on phones.
- **Now on wide pages:** the deck sits beside the work from 840px of page width; from 1500px the deck column holds at 600px, the work column widens to 920px and its card lists run two across. Sessions are one frosted list grouped by computer, with every idle session in one "Idle" fold after it.
- `Fold` is the one disclosure: a quiet mono line with a turning chevron ("Waiting on you (2)", "Idle (3)", "Show 4 more").
- Now lists: live work (needs you, running, folds) is a sheet card (`WorkCard` live) with title, chip, status, `StepTrack` and origin, a needs-you card adding its toned hairline and 5% tint; settled work (since you looked, today's log) is one frosted `List` of `Row`s led by a `SignalGlyph`. "Show 3 more" and "View history" are coral text links (cyan means running, so it never marks a link).
- **Buttons** (`Button`) are one family; a view leads with at most one primary:
  - `default` (primary): solid light `--primary-fill` with ink text. No gradient, glow, inner highlight or shimmer.
  - `secondary`: the quiet control fill (white 6%, hover 9%); the action beside a primary ("Decline", "Cancel").
  - `outline`: the same fill with a hairline, for a button standing on bare page.
  - `ghost`: muted words, the control fill on hover.
  - `destructive`: red words on red at 12% (18% on hover); it never fills solid.
  - `link`: coral text.
  - Sizes: `sm` 32px r8 13px, `default` 36px r10 14px, `lg` 44px r12 15px, `xs` 24px for inline use; `icon*` squares on the same radii. Press sinks to `--press-scale` (`.press`); focus is the shared 2px violet ring, offset 2px; disabled is 45% opacity.
  - `.capsule-cta` is the 52px hero action (Sign in, Open Dashboard): the primary at hero size, solid light, no glint. Only the landing keeps its coral capsule with the glow and glint (`.landing .capsule-cta`).
- **Inputs, selects and native selects** share one field: 36px, radius 10, white 3% with the 10% input hairline, the strong hairline on hover, and on focus a violet border with a 3px violet halo at 25%.
- **Pills** (`.pill`) are filters and secondary links in the control family: 32px capsules, white 3% with a hairline at rest, the control fill on hover; chosen is the brighter control fill (white 12%) with the strong hairline and full-strength text, the same "chosen" as a segment's thumb and the sidebar's page. They work as toggles (`aria-pressed`) or as styled `select`s. Pill rows scroll sideways on phones (`.no-scrollbar`). Segmented controls (`.segmented`) are a 36px track (radius 10, black 20%) with a sliding thumb.
- **Icon tiles** (`.icon-tile`) are flat: the symbol in its tone over the tone at 15%, a 22% tone hairline (the iPhone's request glyph). Neutral tiles are the control fill. Colour them with a `.tone-*` class.
- **Notices** (`Notice`) are the sheet with a 22% tone hairline and 6% of the tone; the icon carries the colour. `quiet` is an untinted inner box.
- **The owner's initial** is a quiet disc (`.avatar`: white 12%, a hairline), never a gradient.
- `Empty`: orb, title, one sentence. `RouteLoadingFallback`: the loading page's own shape (Now's deck, a titled list, a detail page); see Loading.

## Computer panel

Connections → Computers: a row opens one wide sheet from the right (`computer-panel.tsx`, 44rem on desktop, full width on a phone), not a stack inside the row. A section nav (Overview, On your iPhone, Setup, Settings, Access) switches the body; one section shows at a time, each in `computer-panel/`.

- The header holds the computer's icon and inline rename. Its icon is the only place the computer's own accent colour appears.
- The preview in On your iPhone is drawn like the real Lock Screen card (`NotificationPreview`). Its accent is the project colour, or the fixed colour only when the strategy is fixed; nothing else in the panel is tinted.
- Changes save as they are made. No Save button, no nested sheet.

## Navigation

- **Desktop:** a floating glass sidebar with Now, History, Projects, Connections and Test Lab, then a "Settings" group with Account and Documentation (the public docs at `/docs`), then the profile menu. It folds to a 56px icon rail (the button beside the wordmark, the edge rail, or ⌘B / Ctrl+B) and opens as the owner last left it; labels fade out as it folds and back in after it opens. Folded, every row names itself and its shortcut in a tooltip ("History · G H"), "Settings" becomes a hairline, the needs-you count becomes an orange dot, and the profile menu opens to the right. Tablets (768–1099px) always start on the rail; opening it lays the sidebar over the page with a scrim and it closes on navigation, Escape or a tap outside.
- **Keyboard:** `g` then n/h/p/c/t/a jumps to a page, ⌘K opens the command menu (pages, fold the sidebar, sign out), `?` lists every shortcut.
- **Page frames** are left-aligned at the gutter, so the title sits in the same place on every page. A detail page passes `back` to `Page`: a quiet trail in the top inset on desktop ("History › Notification"), a 44pt back chevron on phones.
- **Phones:** no top bar; the large title sits under the safe area, as on iOS. When it scrolls away, a frosted 44pt compact bar fades in with the title centred (`CompactBar`). A bottom tab bar holds Now, History, Projects, Connections and More: 24px icons, the active one on a coral pill, pressed tabs shrink slightly, and tapping the current tab glides back to the top. More opens a bottom sheet with the owner, Test Lab, Account and Documentation as Settings-style rows, Sign out, and the version.
- **Everywhere:** the needs-you count is one orange badge (`NeedsYouBadge`: a number capped at 9+, or a dot on the rail) that screen readers hear as words, and it leads the tab title ("(3) Now · Relo"). After a client navigation focus moves to the new page's title and "<title> loaded" is announced.

## Motion

- **One system** in `styles/motion.css`, mirrored for JS in `lib/motion.ts`. Durations: micro 120, fast 180, base 260, slow 420 ms; sheets 340 ms; ambient fades 1200 ms. Things arrive on `--ease-out` and leave on `--ease-in` at about 0.7× the arrival. Springs are defined as Apple does (response, damping fraction) and exist twice: `SPRINGS.press|snappy|smooth|bouncy` for `motion`, and `--spring-*` `linear()` curves with `--spring-*-dur` for CSS. Movement (layout, indicators) uses snappy; bouncy only for success moments, never lists.
- **Utilities:** `.press` (sinks to `--press-scale` .97 in `--dur-micro`, springs back on `--spring-press`), `.hover-fade`, `.tint` (crossfades the registered `--tone`/`--glow` over `--dur-slow`, so a card going from running to needs you tints in one move). Use them instead of writing transitions.
- **One heartbeat:** everything alive breathes on `--period-breath` (4 s; half for urgency), phase-locked to the page clock by `lib/heartbeat.ts` (`--breath-epoch`), so every dot, the deck's glow, the current step and the orb's halo breathe together.
- **Never:** animate width, height, top or left (except `AnimatedHeight`'s `auto`), put a filter on a glass ancestor (it switches off the frost; rest at `filter: none`), or loop a box-shadow or background-position (use a pseudo-element). Reduced motion makes every change instant and stops every loop; reduced transparency and more contrast set `--glass-blur` to 0 and give glass a solid fill.
- **Now moves with the server, never a clock.** Each refresh is compared with the previous one and only its differences animate; the first paint is still. Sections lead with their heading, items follow 60 ms later (40 ms stagger). State changes happen in place: `--tone` crossfades, chips pop on a tight spring, step segments fill from the left. Finishing is choreographed, not morphed: a 350 ms completion beat (mint, DONE, full steps), then the card lifts away while its row lands at the top of Since you looked. Something newly needing you rings its card once and jumps the deck's centre to Needs you. Folds are destinations: an item moving into a closed fold drops toward its summary while the count rolls.
- **Navigation says where you went.** A sibling page crossfades in 160 ms with the title only fading; a detail page is pushed (24 px from the right, 280 ms); its back link pops the parent (16 px from the left, 220 ms); Back/Forward restore instantly. One indicator marks the page (the sidebar's control-fill pill with the icon in coral, the tab bar's coral capsule) and glides on snappy; a tab press sinks only its icon. Folding the sidebar sweeps a clip over the glass edge (the frosted box never resizes) while the page column changes width once and glides. Sheets travel their full width on the sheet curve (380/240 ms) over a scrim that only fades; menus grow from their trigger (160/100 ms), tooltips barely scale (100 ms), the command menu drops in (220/140 ms) with a highlight that follows the keys.
- **Feedback answers where the owner is looking and never moves the page.** `ActionButton` shows the work on the button: the label crossfades to a spinner at the label's width, success draws a check with one short word for 1.6 s, a refusal shakes once (0, −8, 7, −5, 3, 0 px over 420 ms) and puts the cursor back in the field. Messages open and close in place (`AnimatedHeight`), changed words crossfade in a fixed line, lists change in place (`List` with `items`, `PresenceList`), choices slide one lit capsule (`SelectionIndicator`), copies turn their icon into a check (`CopyButton`), and on a pointer one highlight glides between a list's rows.

## Landing and sign-in

- **`/` for a signed-out visitor to a claimed server** is the landing page (`features/landing`). An unclaimed server, or any `?next=` return path, goes straight to the form; the form lives at `/sign-in` and every sign-in redirect points there.
- The landing leads with the value proposition ([docs/VALUE-PROPOSITION.md](../../docs/VALUE-PROPOSITION.md)): the hero subtitle names agents, scripts and apps wherever they run, and the section right under it (`#one-place`) shows sources (laptop, another computer, home server or cloud, your app) converging on Relo and the four things the owner gets (live status, time-sensitive alerts, details, input). Plans, sessions and hooks come later, as supporting features.
- The landing hero is the Relo core in its hero framing (`landing-scene.ts` over `lib/orb-scene.ts`, with a bloom pass): the plasma core in the meaning colours, instrument rings, and agent signals streaming in as comets that ripple the core. It loads in its own chunk after first paint, compiles its shaders asynchronously, pauses off screen, renders one still frame under reduced motion, and falls back to a painted orb without WebGL. Colours go through `THREE.Color` (linear), and the background is `scene.background`, never a raw clear colour, so nothing is encoded twice.
- GSAP (`landing-motion.ts`) only reveals and loops: section titles rise by line, blocks lift in once, and the three demos (the live Lock Screen card, the `relo ask` terminal with its approve card, the sealed-to-plain privacy cards) play while visible. Scrolling stays native; nothing is pinned or scrubbed into a story.
- Comets end just outside the orb's displaced surface and aim at its visible face; each impact ripple is placed in the spinning orb's own frame so it starts where the comet hit.
- GSAP never owns a property something else owns: entrances move the CTA row (magnetic hover moves the buttons), and the chip float uses yPercent (the entrance uses y). Landing-only rules are unlayered, so they beat Tailwind utilities: never pair a landing class that sets `display` with `hidden`/`md:hidden`.
- A "Pause motion" control in the nav stops GSAP, the scene and CSS loops. An error boundary keeps a plain page if the chunk or motion fails, and hidden reveals are forced visible in print.
- The sign-in page shows no server row (the address bar already says it) and fits one phone screen: a 200px deck, 150px on short screens.
- Landing sections have no kicker above the title: the title is enough.
- Rising text: every line mask (hero `.landing-line`, SplitText `.split-line-mask`) is padded 0.2em below and offset by a negative margin, so descenders fit; lines start at yPercent 130. After the entrance the hero masks stop clipping and section titles revert their split, so text at rest is plain.
- Load path: the server reads Vite's manifest (`dist/.vite/manifest.json`) and lists the landing chunk, its CSS and imports (and the scene at low priority) in the landing document, so they download with the entry instead of one round trip after another. The hero copy animates in at once and never waits for WebGL.
- Below 1024px the core takes the top band and the copy follows beneath it. Phones (below 720px, the "Phones" block in `landing.css`) get their own layouts rather than stacked desktop ones: the `#one-place` sources and outcomes become 2×2 tiles around the hub; Stay in control shows a smaller phone and tighter question rows; privacy becomes a timeline down the screen instead of four boxes; the feature cards become a swipeable row that snaps and peeks the next card. The floating hero chips appear only on wide screens (1280px and up).
- The sign-in page on desktop is the core alone on a 600px stage (`OrbStage`), beside the card; phones keep a compact stage with the headline.
- Both pages link to the public GitHub repository (`features/auth/github.tsx`); the sign-in page returns to the landing through the logo.

## Loading and moving between pages

- **Rules.** Structure paints at once: it is the page. Loading signals (the core's breath, shimmer, the rail) appear only after 400 ms; words only after 1 s. Anything shown stays at least 500 ms and leaves on a `--dur-base` fade. No percentages or fake progress; numbers are real from the first frame. Focus never moves during a load. Reduced motion: nothing breathes, shimmers or travels (the rail is a still line); the words still appear.
- **First frame.** The server renders each Dashboard page's skeleton into `#root` (`apps/server/src/web/dashboard-skeleton.ts`) in the class names React renders (a parity test pins title, deck stage and readouts). It shows the sidebar with the wordmark (the tab bar on phones, the rail on tablets), the page frame and the real title. On Now it shows the deck with the painted core in today's colours and the four readouts with the server's numbers; the colours come from the shared `orb-palette` in `@relo/notification-contracts`, the same function the scene uses. Only the body is placeholder rows (one per open item, at most four). After 400 ms the core breathes (.45 to .6 on the heartbeat) and rows shimmer. After 1 s "Starting Relo" appears under the core, and after 8 s it reads "Taking longer than usual · Reload". All of this is CSS only: the CSP allows no inline script. The page keeps `<main aria-busy>` and one polite status ("Loading Now").
- **Preloads.** The document lists the page's chunk, its CSS and imports, and the motion features as `modulepreload`. Now adds the orb scene at low priority, and the landing keeps its own list.
- **Hand-off.** `main.tsx` awaits the page's chunk and, on a linked browser, its sealed text (800 ms budget). It then renders in a transition, so React's first commit replaces the skeleton at identical geometry and never shows a Suspense fallback (the page loaders mark their promise fulfilled). The skeleton rows stay as a still copy fading out while the real rows fade in (opacity only), and words already shown keep their 500 ms.
- **Sealed text.** A linked browser (a local hint, set while the link reports linked) waits up to 800 ms. After that, sealed text shows a lock and a placeholder line, and after 400 ms the words "Opening on this device". Each row's text crossfades in when opened (`--dur-fast`, 40 ms apart). A failure, or 5 s, shows the honest "End-to-end encrypted · open on iPhone to read". An unlinked browser shows that at once.
- **Navigation.** The page stays until the next one is ready. After 400 ms a coral segment travels the top hairline (one lap per half breath); arrival sweeps it to the end in `--dur-micro` and fades it in `--dur-fast`. After 3 s the rail turns attention yellow with a Notice, "Still waiting on your server". A network failure keeps the page, turns the rail red and shows "Can't reach your server · Retry", retrying by itself when the browser comes back online. A 401 or a redirect still loads as a document. If a page's code is still loading, the fallback wears that page's shape.
- **Between documents** (landing, sign-in, the Dashboard, the docs: one bundle, one stylesheet, `styles/loading.css`). `@view-transition { navigation: auto }` (only without reduced motion) gives same-origin navigations a short crossfade: the old page leaves in 140 ms on `--ease-in`, the new one arrives in 200 ms on `--ease-out`. Three shared names morph on `--spring-smooth`:
  - `relo-core`: the landing hero stage, the sign-in deck (`.auth-core`), the Now deck stage and the skeleton's painted core. Signing in carries the core to Now, with the wordmark fading as the count arrives.
  - `relo-brand`: the landing nav logo, the sign-in header logo, the expanded sidebar lockup, the skeleton's lockup and the docs header brand.
  - `relo-title`: the Dashboard `h1.page-title` and the docs article `h1`.

  Each name is on one shown element per document; hidden duplicates (the skeleton sidebar on phones) carry none. Names never go on large glass containers, and durations stay short, because snapshots flatten the frost. Signing out and Dashboard ↔ docs use the same rules. Client navigation inside the Dashboard keeps its in-app transitions. Browsers without cross-document view transitions (Firefox, Safari before 18.2) cut.

## E2EE display rules (behaviour, not style)

- Handles (`p-…`, `t-…`, `c-…`, `a-…`, `w-…`) always render through `displayName()`.
- Unopened encrypted items show "End-to-end encrypted · open on iPhone to read".
- The linked-browser QR stays large and unclipped.
- Pending devices are read-only in the browser.
