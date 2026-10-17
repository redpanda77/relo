import { createHash,randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  computerInviteStatusSchema,computerReportSchema,LOGIN_SCOPES,loginScopeSchema,type ComputerInviteStatus,
} from "@relo/notification-contracts";
import { issueLogin } from "./credentials/login.js";
import type { Database } from "./db.js";
import { queueInviteActivityPush } from "./computer-invite-activity.js";
import { credentialMetadata } from "./device-authorization.js";
import { simulatorSql } from "./device-models.js";
import { internalId,publicId } from "./ids.js";

/**
 * Add a computer (docs/site/guides/servers.md): a trusted device makes a one-time code, and one command pasted on the
 * new computer installs the CLI from this server, redeems the code for the computer's own login and runs relo setup.
 * The code is a bearer secret for one sign-in, like a Tailscale auth key: it works once, for 30 minutes, and only its
 * hash is stored. A computer that joins this way is still a computer every device decides on
 * (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
 */
export const INVITE_LIFETIME_MINUTES = 30;
const CODE_PREFIX = "rci_";

export const createInviteSchema = z.object({
  level: z.enum(["notify","track","guide","optimize"]).default("track")
    .describe("How deep relo setup goes on the new computer (relo setup --level); default track, like relo setup."),
  approvals: z.boolean().default(false).describe("Whether the new computer's agents ask permission on the owner's phone too."),
  agents: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)).min(1).max(12).transform((agents) => [...new Set(agents)]).optional()
    .describe("Which agents relo setup sets up there (claude-code, codex, opencode, gemini, cursor, copilot, amp); every agent it finds when omitted."),
}).strict();
export type CreateInvite = z.infer<typeof createInviteSchema>;

export const redeemInviteSchema = z.object({
  code: z.string().regex(/^rci_[A-Za-z0-9_-]{32}$/).describe("The one-time code from Add a computer; it works once, for 30 minutes."),
  clientName: z.string().trim().min(1).max(80).describe("The name the new computer signs in with and shows to the owner."),
  scopes: z.array(loginScopeSchema).min(1).max(LOGIN_SCOPES.length).transform((scopes) => [...new Set(scopes)].sort())
    .describe("What the computer's login may do."),
  expiresInSeconds: z.number().int().min(3_600).max(31_536_000).describe("How long the login works before it must sign in again."),
}).strict();
export type RedeemInvite = z.infer<typeof redeemInviteSchema>;

export type InviteIssuer = { kind: "phone" | "mac" | "browser" | "computer"; name: string };

const codeHash = (code: string) => createHash("sha256").update(`relo-computer-invite\n${code}`).digest("hex");

/** The command the owner pastes on the new computer. */
export const inviteCommand = (origin: string,code: string) => `curl -fsSL ${origin}/install.sh | sh -s -- ${code}`;

/** A new one-time code for the account; the owner sees it (and the command) once. */
export async function createInvite(
  db: Pick<Database,"query">,principalId: string,issuer: InviteIssuer,input: CreateInvite,origin: string,
): Promise<{ inviteId: string; code: string; command: string; expiresAt: string; level: string; approvals: boolean; agents: string[] | null }> {
  const code = `${CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO computer_invites(principal_id,code_hash,issued_by_kind,issued_by_name,setup_level,setup_approvals,setup_agents,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now()+make_interval(mins => $8)) RETURNING id,expires_at`,
    [principalId,codeHash(code),issuer.kind,issuer.name.slice(0,80),input.level,input.approvals,input.agents ?? null,INVITE_LIFETIME_MINUTES]);
  return { inviteId: publicId("cin",result.rows[0]!.id),code,command: inviteCommand(origin,code),expiresAt: result.rows[0]!.expires_at.toISOString(),level: input.level,
    approvals: input.approvals,agents: input.agents ?? null };
}

/**
 * A hint, never content: wakes the account's live streams (Dashboard SSE, phone) so they refetch what changed. Failing to
 * send one is harmless; the streams reconcile on their own.
 */
export async function wakeAccountStreams(db: Pick<Database,"query">,principalId: string): Promise<void> {
  await db.query("SELECT pg_notify('relo_current_changes',json_build_object('principalId',$1::uuid,'subjectId',NULL)::text)",[principalId])
    .catch(() => undefined);
  // The phone's wizard Live Activity moves with the same events (computer-invite-activity.ts).
  await queueInviteActivityPush(db,principalId);
}

export type RedeemError = "invalid_code" | "credential_limit_reached" | "client_name_taken";

/** Redeems a code once: the new computer's own login, and how the owner wants it set up. */
export async function redeemInvite(db: Database,input: RedeemInvite): Promise<
  { ok: true; accessToken: string; credential: ReturnType<typeof credentialMetadata>; setup: { level: string; approvals: boolean; agents: string[] | null } }
  | { ok: false; error: RedeemError }
> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<any>(
      `SELECT id,principal_id,setup_level,setup_approvals,setup_agents FROM computer_invites
       WHERE code_hash=$1 AND redeemed_at IS NULL AND expires_at>now() FOR UPDATE`,[codeHash(input.code)]);
    const invite = found.rows[0];
    if (!invite) {
      await client.query("ROLLBACK");
      return { ok: false,error: "invalid_code" };
    }
    const issued = await issueLogin(client,{ principalId: invite.principal_id,label: input.clientName,scopes: input.scopes,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000) });
    if (issued === "limit_reached" || issued === "name_taken") {
      await client.query("ROLLBACK");
      return { ok: false,error: issued === "limit_reached" ? "credential_limit_reached" : "client_name_taken" };
    }
    await client.query("UPDATE computer_invites SET redeemed_at=now(),redeemed_login_id=$2 WHERE id=$1",[invite.id,issued.row.id]);
    await client.query("COMMIT");
    await wakeAccountStreams(client,invite.principal_id);
    return { ok: true,accessToken: issued.token,credential: credentialMetadata(issued.row),
      setup: { level: invite.setup_level,approvals: invite.setup_approvals,agents: invite.setup_agents ?? null } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The CLI this server hands out (packed into the image at build: cli/manifest.json beside relo-cli.tgz), or null. */
export type BundledCli = { version: string; sha256: string; file: string };
export function bundledCli(directory = new URL("../cli/",import.meta.url)): BundledCli | null {
  try {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json",directory),"utf8"));
    if (typeof manifest?.version !== "string" || !/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? "")) return null;
    return { version: manifest.version,sha256: manifest.sha256,file: new URL("relo-cli.tgz",directory).pathname };
  } catch {
    return null;
  }
}

/**
 * The install script `curl -fsSL <origin>/install.sh | sh -s -- <code>` runs: Node 22 or newer (the one on PATH, or
 * the official build from nodejs.org, checked against its SHASUMS256), this server's CLI checked against its digest
 * and unpacked under ~/.local/share/relo (the CLI has no dependencies), a `relo` launcher in ~/.local/bin that names
 * both by absolute path (services and hooks often run without the shell's PATH), then `relo auth join` with the code,
 * which signs in and runs relo setup as the code says. POSIX sh; nothing runs as root.
 */
export function installScript(origin: string,cli: BundledCli): string {
  // Without a code (`curl -fsSL <origin>/install.sh | sh`) it installs the CLI only; relo auth login signs in.
  return `#!/bin/sh
# Relo: add this computer to your account (generated by ${origin}).
set -eu
ORIGIN='${origin}'
VERSION='${cli.version}'
CLI_SHA256='${cli.sha256}'
NODE_MAJOR=22
CODE="\${1:-}"
HOME_DIR="\${HOME:?}"
DATA="$HOME_DIR/.local/share/relo"
BIN="$HOME_DIR/.local/bin"

say() { printf 'relo: %s\\n' "$*" >&2; }
fail() { say "$*"; exit 1; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$DATA" "$BIN"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Node 22 or newer: the one on PATH, else a private copy from nodejs.org.
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
  NODE=$(command -v node)
  NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
fi
if [ -z "$NODE" ]; then
  case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) fail "unsupported system $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) fail "unsupported processor $(uname -m)" ;; esac
  say "installing Node.js $NODE_MAJOR for Relo (nodejs.org)"
  fetch "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
  FILE=$(grep -o "node-v[0-9.]*-$OS-$ARCH.tar.gz" "$WORK/SHASUMS256.txt" | head -1)
  [ -n "$FILE" ] || fail "no Node.js $NODE_MAJOR build for $OS-$ARCH"
  fetch "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$FILE" "$WORK/$FILE"
  [ "$(sha256 "$WORK/$FILE")" = "$(grep " $FILE\\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)" ] || fail "Node.js download did not match its checksum"
  rm -rf "$DATA/node" && mkdir -p "$DATA/node"
  tar -xzf "$WORK/$FILE" -C "$DATA/node" --strip-components=1
  NODE="$DATA/node/bin/node"
fi

say "installing the Relo CLI $VERSION from $ORIGIN"
fetch "$ORIGIN/cli/relo-cli.tgz" "$WORK/relo-cli.tgz"
[ "$(sha256 "$WORK/relo-cli.tgz")" = "$CLI_SHA256" ] || fail "the CLI download did not match its checksum"
rm -rf "$DATA/cli/$VERSION" && mkdir -p "$DATA/cli/$VERSION"
tar -xzf "$WORK/relo-cli.tgz" -C "$DATA/cli/$VERSION" --strip-components=1
ENTRY="$DATA/cli/$VERSION/bin/relo.mjs"
# A symlink there (an npm install) is replaced, never written through.
rm -f "$BIN/relo"
cat > "$BIN/relo" <<LAUNCHER
#!/bin/sh
# relo launcher: $ENTRY
exec "$NODE" "$ENTRY" "\\$@"
LAUNCHER
chmod 755 "$BIN/relo"
RELO=relo
case ":$PATH:" in *":$BIN:"*) ;; *)
  RELO="$BIN/relo"
  for RC in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
    [ -f "$RC" ] && ! grep -q '.local/bin' "$RC" && printf '\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$RC"
  done
  say "added ~/.local/bin to PATH for new shells" ;;
esac

if [ -z "$CODE" ]; then
  # No code: the CLI only. Sign in with the link and QR code relo auth login shows, then set up the agents.
  say "installed. Next: $RELO auth login --api-url $ORIGIN, then $RELO setup"
  exit 0
fi
NAME=$(hostname 2>/dev/null || uname -n)
# Signs in with the code and runs relo setup the way the owner chose when making it.
"$BIN/relo" auth join "$CODE" --api-url "$ORIGIN" --client-name "$NAME"
say "done: this computer reports to Relo. Restart its agents so they load it."
`;
}

/**
 * Where a code is in its journey (plan 13), derived on every read from the invite, the login it was redeemed for, that
 * login's identity key, the computer's report and the notifications the login has sent. Null for an unknown id or
 * another account's.
 */
export async function inviteStatus(db: Pick<Database,"query">,principalId: string,inviteId: string): Promise<ComputerInviteStatus | null> {
  const id = internalId("cin",inviteId);
  if (!id) return null;
  const row = (await db.query<{
    expires_at: Date; expired: boolean; redeemed_at: Date | null; redeemed_login_id: string | null; label: string | null;
    display_name: string | null; report: unknown; reported_at: Date | null; has_key: boolean; tested: boolean;
    approved: boolean; phone_before: boolean;
    identity_key: string | null; binding: string | null;
  }>(
    `SELECT i.expires_at,i.expires_at<=now() AS expired,i.redeemed_at,i.redeemed_login_id,k.label,c.display_name,c.report,c.reported_at,
       EXISTS (SELECT 1 FROM client_identity_keys e WHERE e.api_key_id=i.redeemed_login_id) AS has_key,
       (SELECT e.public_key FROM client_identity_keys e WHERE e.api_key_id=i.redeemed_login_id) AS identity_key,
       (SELECT e.binding FROM client_identity_keys e WHERE e.api_key_id=i.redeemed_login_id) AS binding,
       EXISTS (SELECT 1 FROM notification_events n WHERE n.requester_credential_id=i.redeemed_login_id) AS tested,
       EXISTS (SELECT 1 FROM computer_approvals a JOIN client_identity_keys e ON e.api_key_id=a.api_key_id AND e.public_key=a.identity_key
               WHERE a.api_key_id=i.redeemed_login_id) AS approved,
       EXISTS (SELECT 1 FROM devices d WHERE d.principal_id=i.principal_id AND d.revoked_at IS NULL AND NOT ${simulatorSql("d")}
               AND d.registered_at<k.created_at) AS phone_before
     FROM computer_invites i
     LEFT JOIN principal_api_keys k ON k.id=i.redeemed_login_id
     LEFT JOIN computers c ON c.login_key_id=i.redeemed_login_id
     WHERE i.id=$1 AND i.principal_id=$2`,[id,principalId])).rows[0];
  if (!row) return null;
  const base = { inviteId: publicId("cin",id),expiresAt: row.expires_at.toISOString() };
  if (!row.redeemed_at) return computerInviteStatusSchema.parse({ ...base,state: row.expired ? "expired" : "waiting",computer: null });
  const state = row.tested ? "tested" : row.reported_at ? "reported" : row.has_key ? "key_published" : "redeemed";
  if (!row.redeemed_login_id) return computerInviteStatusSchema.parse({ ...base,state,computer: null });
  const report = row.reported_at ? computerReportSchema.safeParse(row.report) : null;
  const reported = report?.success ? report.data : null;
  return computerInviteStatusSchema.parse({ ...base,state,computer: {
    clientId: publicId("key",row.redeemed_login_id),
    name: (row.display_name ?? row.label ?? "a computer").slice(0,80),
    cliVersion: reported?.cli.version ?? null,
    harnesses: (reported?.harnesses ?? []).map((harness) => ({ id: harness.id,detected: harness.detected,level: harness.level })),
    identityKey: row.identity_key,binding: row.binding,
    approval: row.approved ? "approved" : row.phone_before ? "waiting" : "not_needed",
    check: reported?.doctor ? { ok: reported.doctor.ok,failing: reported.doctor.failing } : null,
  } });
}
