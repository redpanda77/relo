import { z } from "zod"

/**
 * The public docs site (/docs): one page of the built site plus its navigation. Pages are rendered at build
 * time (apps/server/docs-build); the app shows them in the docs layout. Nothing account-specific is in it:
 * docs are readable signed out, and `viewer` only chooses between "Sign in" and "Open Dashboard".
 */
const docsLinkSchema = z.object({ path: z.string().startsWith("/docs"), title: z.string() })

export const docsSectionSchema = z.object({
  title: z.string(),
  path: z.string().startsWith("/docs").nullable(),
  pages: z.array(docsLinkSchema),
  groups: z.array(z.object({ title: z.string(), pages: z.array(docsLinkSchema) })),
})

export const docsPageSchema = z.object({
  path: z.string().startsWith("/docs"),
  title: z.string(),
  summary: z.string(),
  section: z.string(),
  html: z.string(),
  outline: z.array(z.object({ id: z.string(), text: z.string(), level: z.number().int().min(2).max(3) })),
  editUrl: z.string().url(),
  prev: docsLinkSchema.nullable(),
  next: docsLinkSchema.nullable(),
  breadcrumbs: z.array(z.object({ path: z.string().startsWith("/docs").nullable(), title: z.string() })),
})

export const docsSiteBootstrapSchema = z.object({
  version: z.literal(1),
  kind: z.literal("docs"),
  route: z.object({ path: z.string().startsWith("/docs") }),
  viewer: z.object({ signedIn: z.boolean() }),
  release: z.object({ server: z.string(), cli: z.string() }),
  sections: z.array(docsSectionSchema),
  /** Null: no page at this path (the docs 404, with search). */
  page: docsPageSchema.nullable(),
})

export type DocsSiteBootstrap = z.infer<typeof docsSiteBootstrapSchema>
export type DocsPageView = z.infer<typeof docsPageSchema>
export type DocsSectionView = z.infer<typeof docsSectionSchema>
