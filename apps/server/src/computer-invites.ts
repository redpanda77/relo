import { createHash,randomBytes } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
import { fileURLToPath,pathToFileURL } from "node:url";
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
import { issueMobileSignInCode } from "./mobile-sign-in.js";

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
  macApp: z.boolean().default(false)
    .describe("Whether a Mac also gets Relo for Mac (the notch app), opened already signed in; other systems skip it."),
}).strict();
export type CreateInvite = z.infer<typeof createInviteSchema>;

export const redeemInviteSchema = z.object({
  code: z.string().regex(/^rci_[A-Za-z0-9_-]{32}$/).describe("The one-time code from Add a computer; it works once, for 30 minutes."),
  clientName: z.string().trim().min(1).max(80).describe("The name the new computer signs in with and shows to the owner."),
  scopes: z.array(loginScopeSchema).min(1).max(LOGIN_SCOPES.length).transform((scopes) => [...new Set(scopes)].sort())
    .describe("What the computer's login may do."),
  expiresInSeconds: z.number().int().min(3_600).max(31_536_000).describe("How long the login works before it must sign in again."),
  macAppChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()
    .describe("A PKCE S256 challenge from the Mac app's installer: a code made with Relo for Mac returns its one-time sign-in code for it."),
}).strict();
export type RedeemInvite = z.infer<typeof redeemInviteSchema>;

export type InviteIssuer = { kind: "phone" | "mac" | "browser" | "computer"; name: string };

const codeHash = (code: string) => createHash("sha256").update(`relo-computer-invite\n${code}`).digest("hex");

/** The command the owner pastes on the new computer; `--mac-app` also installs Relo for Mac there (Macs only). */
export const inviteCommand = (origin: string,code: string,macApp = false) =>
  `curl -fsSL ${origin}/install.sh | sh -s -- ${code}${macApp ? " --mac-app" : ""}`;

/** A new one-time code for the account; the owner sees it (and the command) once. */
export async function createInvite(
  db: Pick<Database,"query">,principalId: string,issuer: InviteIssuer,input: CreateInvite,origin: string,
): Promise<{ inviteId: string; code: string; command: string; expiresAt: string; level: string; approvals: boolean; agents: string[] | null;
  macApp: boolean }> {
  const code = `${CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO computer_invites(principal_id,code_hash,issued_by_kind,issued_by_name,setup_level,setup_approvals,setup_agents,setup_mac_app,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(mins => $9)) RETURNING id,expires_at`,
    [principalId,codeHash(code),issuer.kind,issuer.name.slice(0,80),input.level,input.approvals,input.agents ?? null,input.macApp,INVITE_LIFETIME_MINUTES]);
  return { inviteId: publicId("cin",result.rows[0]!.id),code,command: inviteCommand(origin,code,input.macApp),expiresAt: result.rows[0]!.expires_at.toISOString(),level: input.level,
    approvals: input.approvals,agents: input.agents ?? null,macApp: input.macApp };
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

/**
 * Redeems a code once: the new computer's own login, and how the owner wants it set up. A code made with Relo for Mac,
 * redeemed with the installer's PKCE challenge, also returns a one-time sign-in code for the Mac app (the iPhone's
 * browser sign-in code, mobile-sign-in.ts, issued for the account's owner): the app exchanges it with the verifier only
 * it was handed, so it opens signed in. Its encryption keys still wait for a trusted device's approval.
 */
export async function redeemInvite(db: Database,input: RedeemInvite): Promise<
  { ok: true; accessToken: string; credential: ReturnType<typeof credentialMetadata>;
    setup: { level: string; approvals: boolean; agents: string[] | null; macApp: boolean }; macAppSignInCode?: string }
  | { ok: false; error: RedeemError }
> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<any>(
      `SELECT id,principal_id,setup_level,setup_approvals,setup_agents,setup_mac_app FROM computer_invites
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
    let macAppSignInCode: string | undefined;
    if (invite.setup_mac_app && input.macAppChallenge) {
      // The account's owner signs the Mac app in, as when they approve its browser sign-in.
      const owner = await client.query<{ subject: string }>(
        `SELECT subject FROM account_identities WHERE principal_id=$1 AND role='owner' AND disabled_at IS NULL AND approved_at IS NOT NULL
         ORDER BY created_at LIMIT 1`,[invite.principal_id]);
      if (owner.rows[0]) {
        macAppSignInCode = await issueMobileSignInCode({ db: client as unknown as Database,principalId: invite.principal_id,
          subject: owner.rows[0].subject,codeChallenge: input.macAppChallenge });
      }
    }
    await client.query("COMMIT");
    await wakeAccountStreams(client,invite.principal_id);
    return { ok: true,accessToken: issued.token,credential: credentialMetadata(issued.row),
      setup: { level: invite.setup_level,approvals: invite.setup_approvals,agents: invite.setup_agents ?? null,macApp: invite.setup_mac_app },
      ...(macAppSignInCode ? { macAppSignInCode } : {}) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The CLI this server hands out, or null: the one in RELO_ARTIFACTS_DIR/cli when that holds a valid manifest (the deploy
 * publishes there, so a release that changes only the CLI needs no new image), else the one packed into the image at build
 * (cli/manifest.json beside relo-cli.tgz). Read on every call: a manifest replaced at runtime is picked up at once.
 */
export type BundledCli = { version: string; sha256: string; file: string };
export function bundledCli(directory?: URL,artifacts = artifactsDirectory()): BundledCli | null {
  if (!directory) return readCli(artifacts?.cli) ?? readCli(new URL("../cli/",import.meta.url));
  return readCli(directory);
}
/** RELO_ARTIFACTS_DIR (an absolute path) as the `cli/` and `mac/` folders inside it, or null when unset. */
function artifactsDirectory(): { cli: URL; mac: URL } | null {
  const root = process.env.RELO_ARTIFACTS_DIR;
  if (!root || !root.startsWith("/")) return null;
  const base = pathToFileURL(root.endsWith("/") ? root : `${root}/`);
  return { cli: new URL("cli/",base),mac: new URL("mac/",base) };
}
function readCli(directory: URL | undefined): BundledCli | null {
  if (!directory) return null;
  try {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json",directory),"utf8"));
    if (typeof manifest?.version !== "string" || !/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? "")) return null;
    const file = fileURLToPath(new URL("relo-cli.tgz",directory));
    if (!existsSync(file)) return null;
    return { version: manifest.version,sha256: manifest.sha256,file };
  } catch {
    return null;
  }
}

/**
 * Relo for Mac (the notch app) this server hands out, or null: built, signed and zipped on the owner's Mac at deploy
 * (scripts/release/build-mac-app.sh) and copied into the image as mac/relo-mac.zip beside its manifest. The app is GPL
 * and is never part of the public image, so most servers have none and the install script says so.
 */
export type BundledMacApp = {
  version: string; sha256: string; app: string; executable: string; file: string;
  /** Sparkle's update fields (scripts/release/build-mac-app.sh): without an EdDSA signature there is no update feed. */
  update?: { shortVersion: string; build: string; edSignature: string; length: number; minimumSystemVersion?: string };
};
export function bundledMacApp(directory?: URL,artifacts = artifactsDirectory()): BundledMacApp | null {
  if (!directory) return readMacApp(artifacts?.mac) ?? readMacApp(new URL("../mac/",import.meta.url));
  return readMacApp(directory);
}
function readMacApp(directory: URL | undefined): BundledMacApp | null {
  if (!directory) return null;
  try {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json",directory),"utf8"));
    const name = /^[A-Za-z0-9 ._-]{1,60}$/;
    if (typeof manifest?.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(manifest.version) || !/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? "")
      || !name.test(manifest?.app ?? "") || !String(manifest.app).endsWith(".app") || !name.test(manifest?.executable ?? "")) return null;
    // A manifest without its zip is no Mac app: the install script then says so instead of a failed download.
    const file = fileURLToPath(new URL("relo-mac.zip",directory));
    if (!existsSync(file)) return null;
    const update = typeof manifest.edSignature === "string" && /^[A-Za-z0-9+/=]{40,200}$/.test(manifest.edSignature)
      && /^[0-9.]{1,20}$/.test(manifest.shortVersion ?? "") && /^[0-9]{1,9}$/.test(String(manifest.build ?? ""))
      && Number.isSafeInteger(manifest.length) && manifest.length > 0
      ? { shortVersion: manifest.shortVersion,build: String(manifest.build),edSignature: manifest.edSignature,length: manifest.length,
        ...(/^[0-9.]{1,20}$/.test(manifest.minimumSystemVersion ?? "") ? { minimumSystemVersion: manifest.minimumSystemVersion } : {}) }
      : undefined;
    return { version: manifest.version,sha256: manifest.sha256,app: manifest.app,executable: manifest.executable,file,...(update ? { update } : {}) };
  } catch {
    return null;
  }
}

/**
 * Relo for Mac's Sparkle feed (apps/notch ReloUpdater): one item, the build this server hands out, signed with the
 * deploy's EdDSA key. Installed apps compare its build number with their own and install it, automatically or after
 * asking, as their owner chose. Null when the build carries no signature.
 */
export function macAppcast(origin: string,mac: BundledMacApp | null): string | null {
  if (!mac?.update) return null;
  const { shortVersion,build,edSignature,length,minimumSystemVersion } = mac.update;
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Relo for Mac</title>
    <item>
      <title>Relo for Mac ${shortVersion}</title>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>
${minimumSystemVersion ? `      <sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>\n` : ""}      <enclosure url="${origin}/mac/relo-mac.zip" length="${length}" type="application/octet-stream" sparkle:edSignature="${edSignature}"/>
    </item>
  </channel>
</rss>
`;
}

/**
 * The install script `curl -fsSL <origin>/install.sh | sh -s -- <code> [--mac-app]` runs: Node 22 or newer (the one on PATH, or
 * the official build from nodejs.org, checked against its SHASUMS256), this server's CLI checked against its digest
 * and unpacked under ~/.local/share/relo (the CLI has no dependencies), a `relo` launcher in ~/.local/bin that names
 * both by absolute path (services and hooks often run without the shell's PATH), then `relo auth join` with the code,
 * which signs in and runs relo setup as the code says. With --mac-app on a Mac it also puts Relo for Mac in
 * ~/Applications (checked against its digest) and has `relo auth join` open it signed in. POSIX sh; nothing runs as root.
 */
export function installScript(origin: string,cli: BundledCli,mac: BundledMacApp | null = null): string {
  // Without a code (`curl -fsSL <origin>/install.sh | sh`) it installs the CLI only; relo auth login signs in.
  return `#!/bin/sh
# Relo: add this computer to your account (generated by ${origin}).
set -eu
# Everything runs inside main, called on the last line: a download cut short never runs half the script.
main() {
ORIGIN='${origin}'
VERSION='${cli.version}'
CLI_SHA256='${cli.sha256}'
NODE_MAJOR=22
MAC_VERSION='${mac?.version ?? ""}'
MAC_SHA256='${mac?.sha256 ?? ""}'
MAC_APP_NAME='${mac?.app ?? ""}'
MAC_EXECUTABLE='${mac?.executable ?? ""}'
CODE=""
WANT_MAC=""
HOME_DIR="\${HOME:?}"
DATA="$HOME_DIR/.local/share/relo"
BIN="$HOME_DIR/.local/bin"

say() { printf 'relo: %s\\n' "$*" >&2; }
fail() { say "$*"; exit 1; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

for ARG in "$@"; do
  case "$ARG" in
    --mac-app) WANT_MAC=1 ;;
    -*) fail "unknown option $ARG" ;;
    *) [ -z "$CODE" ] && CODE="$ARG" ;;
  esac
done

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
  # Every startup file that exists gets the line; a new account has none, so the one for its shell is made.
  FOUND=""
  for RC in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
    [ -f "$RC" ] || continue
    FOUND=1
    grep -q '.local/bin' "$RC" || printf '\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$RC"
  done
  if [ -z "$FOUND" ]; then
    case "\${SHELL:-}" in */zsh) RC="$HOME_DIR/.zshrc" ;; */bash) RC="$HOME_DIR/.bashrc" ;; *) RC="$HOME_DIR/.profile" ;; esac
    printf 'export PATH="$HOME/.local/bin:$PATH"\\n' >> "$RC"
  fi
  say "added ~/.local/bin to PATH for new shells" ;;
esac

# Relo for Mac (--mac-app): the notch app, from this server, replacing an earlier copy (quit first).
APP=""
if [ -n "$WANT_MAC" ]; then
  if [ "$(uname -s)" != Darwin ]; then
    say "Relo for Mac runs on Macs; skipped here"
  elif [ -z "$MAC_SHA256" ]; then
    say "this server has no Relo for Mac to install; skipped"
  else
    say "installing Relo for Mac $MAC_VERSION from $ORIGIN"
    fetch "$ORIGIN/mac/relo-mac.zip" "$WORK/relo-mac.zip"
    [ "$(sha256 "$WORK/relo-mac.zip")" = "$MAC_SHA256" ] || fail "the Relo for Mac download did not match its checksum"
    mkdir -p "$WORK/mac" && ditto -x -k "$WORK/relo-mac.zip" "$WORK/mac"
    [ -d "$WORK/mac/$MAC_APP_NAME" ] || fail "the Relo for Mac download holds no $MAC_APP_NAME"
    pkill -x "$MAC_EXECUTABLE" >/dev/null 2>&1 && sleep 1 || true
    # Relo for Mac was called Relo Notch until 0.2: its old copy goes, so one Relo is left.
    if [ "$MAC_APP_NAME" != "Relo Notch.app" ] && [ -d "$HOME_DIR/Applications/Relo Notch.app" ]; then
      pkill -x "Relo Notch" >/dev/null 2>&1 && sleep 1 || true
      rm -rf "$HOME_DIR/Applications/Relo Notch.app"
    fi
    mkdir -p "$HOME_DIR/Applications"
    APP="$HOME_DIR/Applications/$MAC_APP_NAME"
    rm -rf "$APP"
    mv "$WORK/mac/$MAC_APP_NAME" "$APP"
  fi
fi

if [ -z "$CODE" ]; then
  [ -z "$APP" ] || open "$APP" --args --relo-origin "$ORIGIN"
  # No code: the CLI only. Sign in with the link and QR code relo auth login shows, then set up the agents.
  say "installed. Next: $RELO auth login --api-url $ORIGIN, then $RELO setup"
  exit 0
fi
NAME=$(hostname 2>/dev/null || uname -n)
# Signs in with the code and runs relo setup the way the owner chose when making it.
if [ -n "$APP" ]; then
  "$BIN/relo" auth join "$CODE" --api-url "$ORIGIN" --client-name "$NAME" --mac-app "$APP"
else
  "$BIN/relo" auth join "$CODE" --api-url "$ORIGIN" --client-name "$NAME"
fi
say "done: this computer reports to Relo. Restart its agents so they load it."
}
main "$@"
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
