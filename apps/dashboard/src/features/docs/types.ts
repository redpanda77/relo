import { z } from "zod"

const documentationLinkSchema = z.object({
  label: z.string(),
  href: z.string().startsWith("/"),
})

export const documentationDashboardBootstrapSchema = z.object({
  version: z.literal(1),
  kind: z.literal("docs"),
  route: z.object({ path: z.literal("/dashboard/docs") }),
  shell: z.object({
    title: z.literal("Documentation"),
    description: z.string(),
    active: z.literal("docs"),
    releaseIdentity: z.string(),
    account: z.object({
      id: z.string(),
      initial: z.string(),
      name: z.string(),
      email: z.string(),
    }),
  }),
  introduction: z.string(),
  sections: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      links: z.array(documentationLinkSchema),
    })
  ),
  machineLinks: z.array(documentationLinkSchema),
})

export type DocumentationDashboardBootstrap = z.infer<
  typeof documentationDashboardBootstrapSchema
>
