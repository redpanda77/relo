import { ClientsPage } from "@/features/connections/clients-page"
import { PhonesPage } from "@/features/connections/phones-page"
import { ServicesPage } from "@/features/connections/services-page"
import { PairingPage } from "@/features/connections/pairing-page"
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
    case "connections-pairing":
      return <PairingPage initial={bootstrap} />
    case "connections-services":
      return <ServicesPage initial={bootstrap} api={service} />
    case "connections-phones":
      return <PhonesPage initial={bootstrap} api={service} />
    case "connections-clients":
      return <ClientsPage initial={bootstrap} api={service} />
  }
}
