import type { ConnectionComputer } from "@/features/connections/types"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"

type Report = NonNullable<ConnectionComputer["report"]>

export function report(overrides: Partial<Report> = {}): Report {
  return {
    cli: { version: "0.17.12", latest: "0.17.12", update: "current" },
    os: { platform: "darwin", release: "25.0" },
    machineKind: "laptop",
    harnesses: [
      { id: "claude-code", detected: true, instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"], skill: "current", hooks: "presence", hooksOutdated: false, mcp: "none" },
    ],
    settings: [
      { key: "server", source: "config", value: "relo.example.test" },
      { key: "project", source: "env", env: "RELO_PROJECT" },
      { key: "computer", source: "config" },
      { key: "updateCheck", source: "default", value: "on" },
    ],
    profiles: { count: 1, active: "default" },
    doctor: { at: "2026-10-16T10:00:00.000Z", ok: true, failing: [] },
    outbox: { pending: 0 },
    ...overrides,
  }
}

export function computer(overrides: Partial<ConnectionComputer> = {}): ConnectionComputer {
  return {
    id: "cmp_00000000-0000-4000-8000-000000000001",
    loginId: "key_00000000-0000-4000-8000-000000000001",
    name: "Studio Mac",
    label: "studio-mac",
    icon: "laptop",
    iconSource: "default",
    tools: [],
    openCards: 0,
    lastSeenAt: null,
    createdAt: null,
    expiresAt: null,
    prefix: "relo_abc",
    scopes: ["notifications:send"],
    encryption: "encrypts",
    hooks: [],
    liveActivityPolicy: null,
    effectiveLiveActivityPolicy: systemPresentationPolicy,
    liveActivityPolicySource: "system",
    maxActiveCards: null,
    report: null,
    reportedAt: null,
    ...overrides,
  }
}

