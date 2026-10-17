import { IndexedSections, Page, type IndexedSection } from "@/components/page"
import { ciTokensFrom } from "@/features/connections/ci-tokens"
import { CiTokensSection } from "@/features/connections/ci-tokens-page"
import { ComputersSection } from "@/features/connections/computers-section"
import { PhonesSection } from "@/features/connections/phones-page"
import { WebhooksSection } from "@/features/connections/services-page"
import type { ConnectionsDashboardBootstrap } from "@/features/connections/types"
import {
  createHttpConnectionsService,
  type ConnectionsService,
} from "@/services/connections-service"

const defaultConnectionsService = createHttpConnectionsService()

/** The page's sections, in order, for its index. */
function connectionSections(): IndexedSection[] {
  return [
    { id: "phones", title: "Phones" },
    { id: "computers", title: "Computers" },
    { id: "ci-tokens", title: "CI tokens" },
    { id: "webhooks", title: "Webhooks" },
  ]
}

export function ConnectionsFeature({
  bootstrap,
  service = defaultConnectionsService,
}: {
  bootstrap: ConnectionsDashboardBootstrap
  service?: ConnectionsService
}) {
  switch (bootstrap.kind) {
    case "connections":
      return (
        <Page title="Connections">
          <IndexedSections label="Connections sections" sections={connectionSections()}>
            <PhonesSection initial={bootstrap.phones} total={bootstrap.summary.phones} api={service} />
            <ComputersSection
              initial={bootstrap.computers}
              unlinkedHooks={bootstrap.unlinkedHooks}
              total={bootstrap.summary.clients}
              api={service}
            />
            <CiTokensSection initial={ciTokensFrom(bootstrap.ciTokens)} api={service} />
            <WebhooksSection initial={bootstrap.services} total={bootstrap.summary.services} api={service} />
          </IndexedSections>
        </Page>
      )
  }
}
