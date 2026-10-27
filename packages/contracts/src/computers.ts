import { z } from "zod";

/**
 * The icons a computer can show (ADR 0011). One enum, declared here once: the migration's CHECK, the
 * Dashboard's glyphs and the phone's symbols all follow it. An enum, not sensitive, so it travels readable.
 */
export const COMPUTER_ICONS = ["laptop", "desktop", "server", "cloud", "terminal", "build"] as const;
export const computerIconSchema = z.enum(COMPUTER_ICONS);
export type ComputerIcon = z.infer<typeof computerIconSchema>;

/** Where a computer's shown icon comes from: the owner's choice, the CLI's machine-kind hint, or the default. */
export const computerIconSourceSchema = z.enum(["owner", "detected", "default"]);
export type ComputerIconSource = z.infer<typeof computerIconSourceSchema>;

/** The longest display name; the database CHECK uses the same number. */
export const COMPUTER_NAME_MAX = 80;

/** Rename a computer and/or set its icon. `null` clears the field (back to the login's name / automatic). */
export const computerRenameSchema = z.object({
  name: z.string().trim().min(1).max(COMPUTER_NAME_MAX).nullable(),
  icon: computerIconSchema.nullable(),
}).partial().strict().refine((value) => Object.keys(value).length > 0, { message: "Send a name, an icon, or both." });
export type ComputerRename = z.infer<typeof computerRenameSchema>;

/**
 * What a computer reports about itself (ADR 0011, "observed device facts"): sent by the CLI when its setup changes,
 * read-only on the Dashboard. It never carries an environment variable's value, a path, or the value of a setting
 * that is a name (project, account, topic, computer, source): `settings[].value` is absent for those, and for any
 * setting taken from a variable. Strict, with a length on every string; the whole report is capped by
 * FACTS.computers.reportMaxBytes, which the route enforces.
 */
const reportText = (max: number) => z.string().min(1).max(max);

export const COMPUTER_REPORT_PLATFORMS = ["darwin", "linux", "win32", "other"] as const;
export const REPORT_INSTRUCTIONS = ["none", "set", "stale", "kept", "hidden"] as const;
export const REPORT_SKILL = ["none", "current", "outdated"] as const;
export const REPORT_HOOKS = ["off", "presence", "approvals", "custom", "legacy"] as const;
export const REPORT_LEVELS = ["notify", "track", "guide", "optimize", "custom", "none"] as const;
export const REPORT_MODULES = ["notify", "reporting", "planning", "continuity", "efficiency"] as const;
export const REPORT_MCP = ["none", "set", "stale"] as const;
export const REPORT_SETTING_SOURCES = ["env", "config", "detected", "default"] as const;

export const computerReportHarnessSchema = z.object({
  /** The harness catalog id: claude-code, codex, … */
  id: reportText(40),
  detected: z.boolean(),
  instructions: z.enum(REPORT_INSTRUCTIONS),
  level: z.enum(REPORT_LEVELS),
  modules: z.array(z.enum(REPORT_MODULES)).max(5),
  skill: z.enum(REPORT_SKILL),
  hooks: z.enum(REPORT_HOOKS),
  hooksOutdated: z.boolean(),
  mcp: z.enum(REPORT_MCP),
}).strict();

export const computerReportSettingSchema = z.object({
  key: reportText(40),
  source: z.enum(REPORT_SETTING_SOURCES),
  /** The variable that overrides it (its name, never its value). */
  env: reportText(64).optional(),
  /** Only for a setting that is neither a name nor a path, and not taken from a variable. */
  value: reportText(200).optional(),
}).strict();

export const computerReportSchema = z.object({
  cli: z.object({
    version: reportText(40),
    latest: reportText(40).nullable(),
    update: z.enum(["current", "behind", "unknown"]),
  }).strict(),
  os: z.object({
    platform: z.enum(COMPUTER_REPORT_PLATFORMS),
    release: z.string().max(64),
  }).strict(),
  /** The CLI's guess at what kind of machine this is; the icon when the owner chose none. */
  machineKind: computerIconSchema.nullable(),
  harnesses: z.array(computerReportHarnessSchema).max(24),
  settings: z.array(computerReportSettingSchema).max(32),
  /** Profile names are local labels: only how many, and the active one's name. */
  profiles: z.object({ count: z.number().int().min(0).max(1000), active: reportText(40) }).strict(),
  /** The last `relo doctor` on this computer: when, whether it passed, and the names of the failing checks. */
  doctor: z.object({
    at: reportText(40),
    ok: z.boolean(),
    failing: z.array(reportText(40)).max(20),
  }).strict().nullable(),
  outbox: z.object({ pending: z.number().int().min(0) }).strict(),
}).strict();
export type ComputerReport = z.infer<typeof computerReportSchema>;

/**
 * Connect a computer (plan 13): where a one-time code is in its journey, as the wizard shows it. Derived by the server
 * from the invite, the login it was redeemed for, that login's identity key, the computer's report and its notices;
 * never stored. `failed` is not a state: a CLI that cannot finish says why in its own terminal, and the wizard keeps
 * waiting with the report's doctor results once there is one.
 */
export const COMPUTER_INVITE_STATES = ["waiting", "redeemed", "key_published", "reported", "tested", "expired"] as const;
export const computerInviteStateSchema = z.enum(COMPUTER_INVITE_STATES);
export type ComputerInviteState = z.infer<typeof computerInviteStateSchema>;

export const computerInviteStatusSchema = z.object({
  /** `cin_<uuid>`, returned when the code is made. */
  inviteId: z.string().regex(/^cin_[0-9a-f-]{36}$/),
  state: computerInviteStateSchema,
  expiresAt: z.string(),
  /** Present once the code is redeemed. */
  computer: z.object({
    /** The computer's login (`key_…`), the id computer approvals and the Devices list use. */
    clientId: z.string(),
    name: z.string().max(COMPUTER_NAME_MAX),
    cliVersion: z.string().max(40).nullable(),
    /** From the report: every harness it knows, found or not, and the level it is set up at (`none` when not). */
    harnesses: z.array(z.object({ id: z.string().max(40), detected: z.boolean(), level: z.enum(REPORT_LEVELS) }).strict()).max(24),
    /** The computer's current identity public key (b64u X9.63), once published; what `approve-computer` signs. */
    identityKey: z.string().max(120).nullable(),
    /**
     * HMAC-SHA256 keyed by the code's binding half, which the server never sees, over
     * "relo.e2e.v1 computer-binding\n" + clientId + "\n" + identityKey (b64u). The device that made the code checks it
     * before it signs `approve-computer`, so a key the server swapped in is never approved. Null without one.
     */
    binding: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
    /**
     * Whether the owner's devices can read what it sends: `approved` once a device signed approve-computer for its
     * current key, `not_needed` when no phone was registered before it joined (devices trust it on first contact),
     * else `waiting` (a phone shows it pending until approved). The server only counts signatures; devices verify them.
     */
    approval: z.enum(["approved", "waiting", "not_needed"]),
    /** The self-check the CLI ran after joining (the report's doctor), or null before the first report. */
    check: z.object({ ok: z.boolean(), failing: z.array(z.string().max(40)).max(20) }).strict().nullable(),
  }).strict().nullable(),
}).strict();
export type ComputerInviteStatus = z.infer<typeof computerInviteStatusSchema>;

/**
 * The command that adds a computer, once per shell family: `posix` pipes the server's install.sh into sh (Linux, macOS),
 * `windows` runs its install.ps1 in PowerShell. Both carry the one-time code, and `-WindowsApp` / `--mac-app` when the
 * code asks for the desktop app. `command` on the invite is `posix`, kept for clients that predate the other.
 */
export const computerInviteCommandsSchema = z.object({ posix: z.string(), windows: z.string() }).strict();
export type ComputerInviteCommands = z.infer<typeof computerInviteCommandsSchema>;

/** What making a code returns: the owner sees the code and its commands once. */
export const computerInviteSchema = z.object({
  inviteId: z.string().regex(/^cin_[0-9a-f-]{36}$/),
  code: z.string(),
  /** The POSIX command (`commands.posix`), for clients that predate `commands`. */
  command: z.string(),
  commands: computerInviteCommandsSchema,
  expiresAt: z.string(),
  level: z.string(),
  approvals: z.boolean(),
  agents: z.array(z.string()).nullable(),
  /** Whether the computer also gets this system's Relo desktop app (Relo for Mac, Relo for Windows), opened signed in. */
  desktopApp: z.boolean(),
}).strict();
export type ComputerInvite = z.infer<typeof computerInviteSchema>;
