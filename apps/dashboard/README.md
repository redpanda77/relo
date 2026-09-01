# Relo Dashboard

React and TypeScript dashboard client built with Vite, Tailwind CSS, and owned shadcn/ui components.
The server injects an authenticated, versioned page bootstrap into `script#relo-dashboard-bootstrap`.

Product truth is recorded in [PRODUCT.md](./PRODUCT.md). Feature boundaries, dependency direction,
and migration seams are recorded in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Adding components

Run the focused checks from the repository root:

```bash
pnpm --filter @relo/dashboard test
pnpm --filter @relo/dashboard typecheck
pnpm --filter @relo/dashboard build
```

This will place the ui components in the `src/components` directory.

## Component ownership

Generated shadcn primitives live in `src/components/ui`. Product-specific atoms, molecules,
organisms, features, services, and state remain separate so the Test Lab can evolve without
forking third-party runtime code.
