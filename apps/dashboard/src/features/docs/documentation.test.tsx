import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DocumentationPage } from "@/features/docs/documentation-page"
import {
  documentationDashboardBootstrapSchema,
  type DocumentationDashboardBootstrap,
} from "@/features/docs/types"

const initial: DocumentationDashboardBootstrap = {
  version: 1,
  kind: "docs",
  route: { path: "/dashboard/docs" },
  shell: {
    title: "Documentation",
    description:
      "Practical entry points for dashboard, CLI, service, and lifecycle workflows.",
    active: "docs",
    releaseIdentity: "test-release",
    account: {
      id: "acc_public",
      initial: "K",
      name: "Relo Owner",
      email: "owner@example.test",
    },
  },
  introduction:
    "Relo is a coordinated notification workflow: delivery, persistent history, phone interaction, and result retrieval are one lifecycle.",
  sections: [
    {
      title: "Send notifications",
      body: "Create a named service.",
      links: [
        {
          label: "Manage services",
          href: "/dashboard/connections/services",
        },
      ],
    },
  ],
  machineLinks: [
    { label: "/docs.md", href: "/docs.md" },
    { label: "/agents.md", href: "/agents.md" },
    { label: "/llms.txt", href: "/llms.txt" },
  ],
}

afterEach(cleanup)

describe("Documentation feature contracts", () => {
  it("renders structured sections and machine documentation as ordinary links", () => {
    const parsed = documentationDashboardBootstrapSchema.parse(initial)
    const { container } = render(<DocumentationPage initial={parsed} />)
    expect(screen.getByRole("heading", { name: "Send notifications" })).toBeVisible()
    expect(screen.getByRole("link", { name: /Manage services/ })).toHaveAttribute(
      "href",
      "/dashboard/connections/services"
    )
    for (const href of ["/docs.md", "/agents.md", "/llms.txt"]) {
      expect(screen.getByRole("link", { name: href })).toHaveAttribute(
        "href",
        href
      )
    }
    expect(container.querySelector("script")).toBeNull()
    expect(container.innerHTML).not.toContain("dangerouslySetInnerHTML")
  })
})
