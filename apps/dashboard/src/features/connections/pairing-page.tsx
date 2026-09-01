import { CheckCircle2, Clock3, QrCode, ShieldCheck } from "lucide-react"
import { useState } from "react"
import {
  ConnectionIconTile,
  ConnectionList,
  ConnectionState,
  ConnectionsPageFrame,
  ConnectionsSectionHeader,
} from "@/features/connections/components"
import type { ConnectionsPairing } from "@/features/connections/types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type IssuedGrant = { qrDataUrl: string; expiresAt: string; origin: string }

export function PairingPage({ initial }: { initial: ConnectionsPairing }) {
  const [issued, setIssued] = useState<IssuedGrant | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function generate() {
    setPending(true)
    setError(null)
    try {
      const response = await fetch("/api/dashboard/connection-grants", {
        method: "POST",
      })
      const payload = await response.json()
      if (!response.ok)
        throw new Error(payload?.error ?? "Could not generate connection QR")
      setIssued(payload)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not generate connection QR"
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <ConnectionsPageFrame bootstrap={initial}>
      <section className="mt-7 space-y-5" aria-labelledby="pairing-heading">
        <ConnectionsSectionHeader
          id="pairing-heading"
          title="Pair an iPhone"
          description="Generate a single-use QR that configures the server and signs the current account into Relo. Each code expires after ten minutes."
        />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,.95fr)]">
          <Card className="relative overflow-hidden bg-card/85">
            <div
              className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-primary/8 blur-3xl"
              aria-hidden="true"
            />
            <CardHeader className="relative">
              <div className="flex items-start gap-3">
                <ConnectionIconTile icon={QrCode} tone="info" />
                <div>
                  <CardTitle>Connection QR</CardTitle>
                  <CardDescription className="mt-1">
                    Open Relo’s sign-in screen, choose Scan QR, and point the
                    camera at this code.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="relative space-y-5">
              <Button
                onClick={generate}
                disabled={pending}
                className="min-h-11"
              >
                <QrCode aria-hidden="true" />
                {pending
                  ? "Generating…"
                  : issued
                    ? "Generate a new QR"
                    : "Generate connection QR"}
              </Button>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {issued ? (
                <div className="grid justify-items-center gap-4 rounded-xl bg-background/55 p-4 ring-1 ring-foreground/10 sm:p-5">
                  <img
                    src={issued.qrDataUrl}
                    alt="Relo single-use connection QR"
                    className="aspect-square w-full max-w-72 rounded-xl bg-white p-3"
                  />
                  <div className="grid gap-2 text-center text-sm">
                    <p className="font-medium text-foreground">Ready to scan</p>
                    <p className="max-w-md text-xs break-all text-muted-foreground">
                      {issued.origin}
                    </p>
                    <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                      <Clock3 className="size-3.5" aria-hidden="true" />
                      Expires {new Date(issued.expiresAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-border bg-background/25 px-6 text-center">
                  <div>
                    <ShieldCheck
                      className="mx-auto size-7 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <p className="mt-3 text-sm font-medium">
                      No active connection code
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Generate one when the phone is ready to scan. Old codes
                      cannot be reused.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="min-w-0">
            <h3 className="text-sm font-medium">Recent connection codes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              A short audit of codes created for this account.
            </p>
            <div className="mt-4">
              {initial.grants.length ? (
                <ConnectionList ariaLabel="Recent connection codes">
                  {initial.grants.map((grant) => (
                    <div
                      key={grant.id}
                      className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0"
                    >
                      <ConnectionIconTile
                        icon={
                          grant.status === "consumed" ? CheckCircle2 : Clock3
                        }
                        tone={
                          grant.status === "consumed"
                            ? "success"
                            : grant.status === "pending"
                              ? "info"
                              : "neutral"
                        }
                      />
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm">
                          {grant.prefix}…
                        </p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          Created {new Date(grant.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <ConnectionState
                        label={grant.status}
                        tone={
                          grant.status === "consumed"
                            ? "success"
                            : grant.status === "pending"
                              ? "warning"
                              : "neutral"
                        }
                      />
                    </div>
                  ))}
                </ConnectionList>
              ) : (
                <div className="rounded-xl bg-card/65 px-5 py-8 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
                  No connection codes generated yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </ConnectionsPageFrame>
  )
}
