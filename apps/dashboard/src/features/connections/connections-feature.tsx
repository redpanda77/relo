import { Page } from "@/components/page"
import { ClientsSection, HarnessCredentialsSection } from "@/features/connections/clients-page"
import { PhonesSection } from "@/features/connections/phones-page"
import { WebhooksSection } from "@/features/connections/services-page"
import type { ConnectionsDashboardBootstrap } from "@/features/connections/types"
import {
  createHttpConnectionsService,
  type ConnectionsService,
} from "@/services/connections-service"

const defaultConnectionsService = createHttpConnectionsService()

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
          <PhonesSection initial={bootstrap.phones} total={bootstrap.summary.phones} api={service} />
          <ClientsSection initial={bootstrap.clients} total={bootstrap.summary.clients} api={service} />
          <HarnessCredentialsSection initial={bootstrap.harnessCredentials} api={service} />
          <WebhooksSection initial={bootstrap.services} total={bootstrap.summary.services} api={service} />
        </Page>
      )
  }
}
