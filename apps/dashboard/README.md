# Relo Dashboard

React and TypeScript web app built with Vite, Tailwind CSS, and owned shadcn/ui components. It is the
signed-out landing page at `/`, the sign-in page at `/sign-in`, and the owner's dashboard under
`/dashboard`. The server renders one Vite document per route and injects a versioned page bootstrap into
`script#relo-dashboard-bootstrap`; the app switches on its `kind`.

Product truth is recorded in the maintainers' private product notes. Feature boundaries and dependency
direction are recorded in [ARCHITECTURE.md](./ARCHITECTURE.md); the visual system in [DESIGN.md](./DESIGN.md).

## Checks

Run the focused checks from the repository root:

```bash
pnpm --filter @relo/dashboard test
pnpm --filter @relo/dashboard typecheck
pnpm --filter @relo/dashboard lint
pnpm --filter @relo/dashboard build
```

The server serves the built `dist/` (the document, `assets/`, and `.vite/manifest.json` for the landing
preloads), so build the dashboard before running the server locally.

## Component ownership

Generated shadcn primitives live in `src/components/ui` and import no feature code. Shared product
presentation (`page.tsx` for `Page`, `Section`, `List`, `Row` and `Empty`; `brand.tsx`; atoms, molecules
and organisms) lives in the rest of `src/components`. Features, services and state remain separate so
product code never forks third-party runtime code.
