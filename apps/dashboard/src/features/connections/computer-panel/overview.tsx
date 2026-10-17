import { Fact, FactList } from "@/components/molecules/fact-list"
import { ToolMarks } from "@/features/connections/computer-row"
import { toolLabel } from "@/components/atoms/source-logo"
import type { ConnectionComputer } from "@/features/connections/types"
import { formatConnectionDate } from "@/features/connections/utils"
import { relativeTime } from "@/lib/format"

export function Overview({ computer }: { computer: ConnectionComputer }) {
  return (
    <FactList columns={2}>
      <Fact label="Tools">
        {computer.tools.length ? (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <ToolMarks tools={computer.tools} max={6} />
            <span className="text-muted-foreground">{computer.tools.map(toolLabel).join(", ")}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">None has run here yet</span>
        )}
      </Fact>
      <Fact label="Open cards">{computer.openCards}</Fact>
      <Fact label="Last seen">{computer.lastSeenAt ? relativeTime(computer.lastSeenAt) : "Not used yet"}</Fact>
      <Fact label="Encryption">
        {computer.encryption === "encrypts" ? (
          "Sends encrypted cards"
        ) : (
          <>
            Not set up for encryption.{" "}
            <a className="text-primary underline-offset-4 hover:underline" href="/dashboard/account#devices">Set it up in Account</a>
          </>
        )}
      </Fact>
      <Fact label="Signed in">{formatConnectionDate(computer.createdAt)}</Fact>
      <Fact label="Expires">{computer.expiresAt ? formatConnectionDate(computer.expiresAt) : "Does not expire"}</Fact>
    </FactList>
  )
}
