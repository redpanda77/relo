import { Page, Section } from "@/components/page"
import { ArrowUpRight, FileCode2 } from "lucide-react"

import type { DocumentationDashboardBootstrap } from "@/features/docs/types"

export function DocumentationPage({
  initial,
}: {
  initial: DocumentationDashboardBootstrap
}) {
  return (
    <Page title={initial.shell.title} eyebrow={initial.introduction}>
      <Section title="Guides">
        <ul className="glass divide-y divide-white/[0.06] overflow-hidden rounded-[20px]">
          {initial.sections.map((section) => (
            <li key={section.title} className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-8">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold">{section.title}</h3>
                <p className="mt-1 max-w-[65ch] text-sm leading-6 text-muted-foreground">
                  {section.body}
                </p>
              </div>
              {section.links.length ? (
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {section.links.map((link) => (
                    <a key={link.href} href={link.href} className="pill">
                      {link.label}
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="For agents and tools">
        <div className="glass flex items-start gap-4 rounded-[20px] p-5">
          <span className="icon-tile tone-violet" aria-hidden="true">
            <FileCode2 />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">Machine-readable guidance</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Machine-readable guidance is available at the following stable
              endpoints.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {initial.machineLinks.map((link) => (
                <a key={link.href} href={link.href} className="pill font-mono text-[12px]">
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </Page>
  )
}
