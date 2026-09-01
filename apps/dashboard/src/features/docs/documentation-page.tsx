import { ArrowUpRight, FileCode2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { DocumentationDashboardBootstrap } from "@/features/docs/types"

export function DocumentationPage({
  initial,
}: {
  initial: DocumentationDashboardBootstrap
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="canvas min-h-[100dvh] px-4 py-7 sm:px-6 lg:px-10 lg:py-10"
    >
      <div className="mx-auto w-full max-w-6xl">
        <header>
          <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            {initial.shell.title}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            {initial.shell.description}
          </p>
        </header>

        <Card className="mt-8 rounded-2xl">
          <CardHeader>
            <CardTitle>Documentation</CardTitle>
            <CardDescription className="max-w-3xl leading-6">
              {initial.introduction}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {initial.sections.map((section) => (
              <section
                key={section.title}
                className="flex min-w-0 flex-col rounded-xl border border-border bg-muted/25 p-5"
              >
                <h2 className="text-base font-medium">{section.title}</h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                  {section.body}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {section.links.map((link) => (
                    <Button
                      key={link.href}
                      asChild
                      variant="outline"
                      className="min-h-11"
                    >
                      <a href={link.href}>
                        {link.label}
                        <ArrowUpRight aria-hidden="true" />
                      </a>
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </CardContent>
        </Card>

        <aside className="mt-5 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted">
              <FileCode2 className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="font-medium">Machine-readable guidance</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Machine-readable guidance is available at the following stable
                endpoints.
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {initial.machineLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="min-h-11 content-center font-mono text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  )
}
