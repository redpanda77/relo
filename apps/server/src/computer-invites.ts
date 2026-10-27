import { createHash,randomBytes } from "node:crypto";
import { existsSync,readFileSync,statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { z } from "zod";
import {
  computerInviteStatusSchema,computerReportSchema,LOGIN_SCOPES,loginScopeSchema,type ComputerInvite,type ComputerInviteCommands,
  type ComputerInviteStatus,
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
  desktopApp: z.boolean().default(false)
    .describe("Whether the new computer also gets this system's Relo desktop app (Relo for Mac, Relo for Windows), opened already signed in; Linux has none and skips it."),
  macApp: z.boolean().optional()
    .describe("Deprecated: the old name of desktopApp, still read from clients that predate it."),
}).strict();
export type CreateInvite = z.infer<typeof createInviteSchema>;

export const redeemInviteSchema = z.object({
  code: z.string().regex(/^rci_[A-Za-z0-9_-]{32}$/).describe("The one-time code from Add a computer; it works once, for 30 minutes."),
  clientName: z.string().trim().min(1).max(80).describe("The name the new computer signs in with and shows to the owner."),
  scopes: z.array(loginScopeSchema).min(1).max(LOGIN_SCOPES.length).transform((scopes) => [...new Set(scopes)].sort())
    .describe("What the computer's login may do."),
  expiresInSeconds: z.number().int().min(3_600).max(31_536_000).describe("How long the login works before it must sign in again."),
  desktopAppChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()
    .describe("A PKCE S256 challenge from the desktop app's installer: a code made with the desktop app returns its one-time sign-in code for it."),
  macAppChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()
    .describe("Deprecated: the old name of desktopAppChallenge."),
}).strict();
export type RedeemInvite = z.infer<typeof redeemInviteSchema>;

export type InviteIssuer = { kind: "phone" | "mac" | "browser" | "computer"; name: string };

const codeHash = (code: string) => createHash("sha256").update(`relo-computer-invite\n${code}`).digest("hex");

/**
 * The command the owner pastes on the new computer, for each shell family. With the desktop app, `--mac-app` (Macs)
 * and `-WindowsApp` (Windows) install this system's own app there; Linux skips it.
 */
export const inviteCommand = (origin: string,code: string,desktopApp = false): ComputerInviteCommands => ({
  posix: `curl -fsSL ${origin}/install.sh | sh -s -- ${code}${desktopApp ? " --mac-app" : ""}`,
  windows: `& ([scriptblock]::Create((irm ${origin}/install.ps1))) ${code}${desktopApp ? " -WindowsApp" : ""}`,
});
/** Without a code: the CLI only (`relo auth login` signs in). */
export const installCommandWithoutCode = (origin: string): ComputerInviteCommands => ({
  posix: `curl -fsSL ${origin}/install.sh | sh`,windows: `irm ${origin}/install.ps1 | iex`,
});

/** A new one-time code for the account; the owner sees it (and the command) once. */
export async function createInvite(
  db: Pick<Database,"query">,principalId: string,issuer: InviteIssuer,input: CreateInvite,origin: string,
): Promise<ComputerInvite> {
  const desktopApp = input.desktopApp || input.macApp === true;
  const code = `${CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
  const result = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO computer_invites(principal_id,code_hash,issued_by_kind,issued_by_name,setup_level,setup_approvals,setup_agents,setup_desktop_app,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(mins => $9)) RETURNING id,expires_at`,
    [principalId,codeHash(code),issuer.kind,issuer.name.slice(0,80),input.level,input.approvals,input.agents ?? null,desktopApp,INVITE_LIFETIME_MINUTES]);
  const commands = inviteCommand(origin,code,desktopApp);
  return { inviteId: publicId("cin",result.rows[0]!.id),code,command: commands.posix,commands,expiresAt: result.rows[0]!.expires_at.toISOString(),level: input.level,
    approvals: input.approvals,agents: input.agents ?? null,desktopApp };
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
 * Redeems a code once: the new computer's own login, and how the owner wants it set up. A code made with the desktop
 * app, redeemed with the installer's PKCE challenge, also returns a one-time sign-in code for the app (the iPhone's
 * browser sign-in code, mobile-sign-in.ts, issued for the account's owner): the app exchanges it with the verifier only
 * it was handed, so it opens signed in. Its encryption keys still wait for a trusted device's approval.
 */
export async function redeemInvite(db: Database,input: RedeemInvite): Promise<
  { ok: true; accessToken: string; credential: ReturnType<typeof credentialMetadata>;
    setup: { level: string; approvals: boolean; agents: string[] | null; desktopApp: boolean }; desktopAppSignInCode?: string }
  | { ok: false; error: RedeemError }
> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<any>(
      `SELECT id,principal_id,setup_level,setup_approvals,setup_agents,setup_desktop_app FROM computer_invites
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
    let desktopAppSignInCode: string | undefined;
    const challenge = input.desktopAppChallenge ?? input.macAppChallenge;
    if (invite.setup_desktop_app && challenge) {
      // The account's owner signs the desktop app in, as when they approve its browser sign-in.
      const owner = await client.query<{ subject: string }>(
        `SELECT subject FROM account_identities WHERE principal_id=$1 AND role='owner' AND disabled_at IS NULL AND approved_at IS NOT NULL
         ORDER BY created_at LIMIT 1`,[invite.principal_id]);
      if (owner.rows[0]) {
        desktopAppSignInCode = await issueMobileSignInCode({ db: client as unknown as Database,principalId: invite.principal_id,
          subject: owner.rows[0].subject,codeChallenge: challenge });
      }
    }
    await client.query("COMMIT");
    await wakeAccountStreams(client,invite.principal_id);
    return { ok: true,accessToken: issued.token,credential: credentialMetadata(issued.row),
      setup: { level: invite.setup_level,approvals: invite.setup_approvals,agents: invite.setup_agents ?? null,desktopApp: invite.setup_desktop_app },
      ...(desktopAppSignInCode ? { desktopAppSignInCode } : {}) };
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
/** RELO_ARTIFACTS_DIR (an absolute path) as the `cli/`, `mac/` and `windows/` folders inside it, or null when unset. */
function artifactsDirectory(): { cli: URL; mac: URL; windows: URL } | null {
  const root = process.env.RELO_ARTIFACTS_DIR;
  if (!root || !isAbsolute(root)) return null;
  const base = new URL(pathToFileURL(root).href.replace(/\/?$/,"/"));
  return { cli: new URL("cli/",base),mac: new URL("mac/",base),windows: new URL("windows/",base) };
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
  /** The DMG people download (plan 16), beside the zip; absent from a development-signed build. */
  dmg?: string;
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
    const dmg = fileURLToPath(new URL("relo-mac.dmg",directory));
    return { version: manifest.version,sha256: manifest.sha256,app: manifest.app,executable: manifest.executable,file,
      ...(existsSync(dmg) ? { dmg } : {}),...(update ? { update } : {}) };
  } catch {
    return null;
  }
}

/**
 * Relo for Mac's Sparkle feed (apps/notch ReloUpdater): one item, the build this server hands out, signed with the
 * deploy's EdDSA key. Installed apps compare its build number with their own and install it, automatically or after
 * asking, as their owner chose. Apple silicon only (the app carries an arm64 server): hardwareRequirements keeps Intel
 * Macs from being offered it. Null when the build carries no signature.
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
${minimumSystemVersion ? `      <sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>\n` : ""}      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <enclosure url="${origin}/mac/relo-mac.zip" length="${length}" type="application/octet-stream" sparkle:edSignature="${edSignature}"/>
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
# A launcher Relo for Mac wrote means this computer ran Relo in the app (managed updates); this install replaces it.
FROM_MAC_APP=""
if [ -f "$BIN/relo" ] && [ ! -L "$BIN/relo" ] && grep -q '# Written by Relo for Mac' "$BIN/relo" 2>/dev/null; then FROM_MAC_APP=1; fi
# A symlink there (an npm install) is replaced, never written through.
rm -f "$BIN/relo"
cat > "$BIN/relo" <<LAUNCHER
#!/bin/sh
# relo launcher: $ENTRY
exec "$NODE" "$ENTRY" "\\$@"
LAUNCHER
chmod 755 "$BIN/relo"
if [ -n "$FROM_MAC_APP" ]; then
  say "this replaced the launcher Relo for Mac wrote: switching the CLI to update itself again (relo update --mode auto)"
  "$BIN/relo" update --mode auto || say "could not switch the CLI's update mode; run: $BIN/relo update --mode auto"
fi
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
    # An installed Relo.app is replaced where it is (/Applications or ~/Applications), never copied next to it.
    APP=""
    for DIR in /Applications "$HOME_DIR/Applications"; do
      [ -d "$DIR/$MAC_APP_NAME" ] && [ -w "$DIR" ] && { APP="$DIR/$MAC_APP_NAME"; break; }
    done
    if [ -z "$APP" ]; then
      mkdir -p "$HOME_DIR/Applications"
      APP="$HOME_DIR/Applications/$MAC_APP_NAME"
    fi
    # A second copy in the other folder would be a second Relo: it goes.
    for DIR in /Applications "$HOME_DIR/Applications"; do
      [ "$DIR/$MAC_APP_NAME" != "$APP" ] && [ -d "$DIR/$MAC_APP_NAME" ] && [ -w "$DIR" ] && rm -rf "$DIR/$MAC_APP_NAME"
    done
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
 * Relo for Windows this server hands out, or null: built on the owner's Windows machine at deploy
 * (scripts/release/build-windows-app.mjs) and copied into the image as windows/relo-windows-setup.exe beside its
 * manifest. Like the Mac app it is never part of the public image, so most servers have none and the install script says so.
 */
export type BundledWindowsApp = {
  version: string; sha256: string; executable: string; file: string;
  /** The update payload (the installer zipped), beside the installer; with `update` it is what installed apps download. */
  zip?: string;
  /** The Tauri updater's fields: without the payload and its minisign signature there is no update feed. */
  update?: { signature: string; notes: string; pubDate: string; critical?: boolean };
};
export function bundledWindowsApp(directory?: URL,artifacts = artifactsDirectory()): BundledWindowsApp | null {
  if (!directory) return readWindowsApp(artifacts?.windows) ?? readWindowsApp(new URL("../windows/",import.meta.url));
  return readWindowsApp(directory);
}
function readWindowsApp(directory: URL | undefined): BundledWindowsApp | null {
  if (!directory) return null;
  try {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json",directory),"utf8"));
    const executable = manifest?.executable ?? "Relo.exe";
    if (typeof manifest?.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(manifest.version) || !/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? "")
      || !/^[A-Za-z0-9 ._-]{1,60}\.exe$/.test(executable)) return null;
    // A manifest without its installer is no Windows app: the install script then says so instead of a failed download.
    const file = fileURLToPath(new URL("relo-windows-setup.exe",directory));
    if (!existsSync(file)) return null;
    const zip = fileURLToPath(new URL("relo-windows.zip",directory));
    const signed = typeof manifest.signature === "string" && /^[A-Za-z0-9+/=]{40,4000}$/.test(manifest.signature) && existsSync(zip);
    const update = signed ? {
      signature: manifest.signature as string,
      notes: typeof manifest.notes === "string" ? manifest.notes.slice(0,2000) : "",
      pubDate: typeof manifest.pubDate === "string" && !Number.isNaN(Date.parse(manifest.pubDate)) ? new Date(manifest.pubDate).toISOString() : new Date(statSync(file).mtimeMs).toISOString(),
      // A critical update (Sparkle's isCriticalUpdate): the app says "Important update" and does not let Later hide it.
      ...(manifest.critical === true ? { critical: true } : {}),
    } : undefined;
    return { version: manifest.version,sha256: manifest.sha256,executable,file,...(existsSync(zip) ? { zip } : {}),...(update ? { update } : {}) };
  } catch {
    return null;
  }
}

/**
 * Relo for Windows' update feed (Tauri updater v2, static JSON): the build this server hands out, its zip signed with the
 * deploy's updater key. Installed apps compare its version with their own. Null when the build carries no signature.
 */
export function windowsUpdateFeed(origin: string,windows: BundledWindowsApp | null) {
  if (!windows?.update) return null;
  return { version: windows.version,notes: windows.update.notes,pub_date: windows.update.pubDate,
    ...(windows.update.critical ? { critical: true } : {}),
    platforms: { "windows-x86_64": { signature: windows.update.signature,url: `${origin}/windows/relo-windows.zip` } } };
}

/**
 * The install script `irm <origin>/install.ps1 | iex` (or, with the code, `& ([scriptblock]::Create((irm <origin>/install.ps1))) <code> [-WindowsApp]`)
 * runs, the Windows counterpart of install.sh, per user and never as administrator: Node 22 or newer (the one on PATH, or
 * the official zip from nodejs.org for this processor, checked against its SHASUMS256, under %LOCALAPPDATA%\Relo\node), this
 * server's CLI checked against its digest and unpacked by the system's own tar.exe (never Git Bash's) under
 * %LOCALAPPDATA%\Relo\cli\<version>, a relo.cmd launcher in %LOCALAPPDATA%\Relo\bin in the format
 * packages/cli/src/owner/windows-launcher.mjs writes and recognizes (it names Node and the entry by absolute path), that folder
 * on the user Path (the registry's raw value, then WM_SETTINGCHANGE), then `relo auth join` with the code. With -WindowsApp it
 * also installs Relo for Windows (the per-user installer, checked against its digest) and has `relo auth join` open it
 * signed in. -NoPath (or RELO_INSTALL_NO_PATH=1) leaves the Path alone; the tests use it. ASCII only, whatever the console's code page.
 */
export function installScriptPowerShell(origin: string,cli: BundledCli,windowsApp: BundledWindowsApp | null = null): string {
  return String.raw`# Relo: add this computer to your account (generated by ${origin}).
# Everything runs inside Install-Relo, called on the last line: a download cut short never runs half the script.
function Install-Relo {
  param([string[]]$Arguments)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }

  $Origin = '${origin}'
  $Version = '${cli.version}'
  $CliSha256 = '${cli.sha256}'
  $NodeMajor = 22
  $AppVersion = '${windowsApp?.version ?? ""}'
  $AppSha256 = '${windowsApp?.sha256 ?? ""}'
  $AppExecutable = '${windowsApp?.executable ?? ""}'
  $Code = ''
  $WantApp = $false
  $SkipPath = ($env:RELO_INSTALL_NO_PATH -eq '1')

  function Say($text) { Write-Host ('relo: ' + $text) }
  function Fail($text) { throw ('relo: ' + $text) }
  function Sha256Of($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
  function Download($url, $path) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path }
  function WriteText($path, $text) {
    # UTF-8 without a byte order mark, written beside the target and moved over it (the launcher may be running right now).
    $next = $path + '.' + $PID + '.tmp'
    [IO.File]::WriteAllBytes($next, (New-Object Text.UTF8Encoding($false)).GetBytes($text))
    for ($try = 1; $true; $try++) {
      try { Move-Item -LiteralPath $next -Destination $path -Force; return } catch {
        if ($try -ge 6) { Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue; throw }
        Start-Sleep -Milliseconds (150 * $try)
      }
    }
  }

  foreach ($arg in $Arguments) {
    if ($arg -eq '-WindowsApp') { $WantApp = $true }
    elseif ($arg -eq '-NoPath') { $SkipPath = $true }
    elseif ($arg.StartsWith('-')) { Fail ('unknown option ' + $arg) }
    elseif ($Code -eq '') { $Code = $arg }
  }

  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set' }
  $Root = Join-Path $env:LOCALAPPDATA 'Relo'
  $Bin = Join-Path $Root 'bin'
  $NodeDir = Join-Path $Root 'node'
  $CliDir = Join-Path (Join-Path $Root 'cli') $Version
  $Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $Tar)) { Fail 'this Windows has no tar.exe (Windows 10 version 1803 or newer is needed)' }
  New-Item -ItemType Directory -Force -Path $Root, $Bin | Out-Null
  $Work = Join-Path ([IO.Path]::GetTempPath()) ('relo-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $Work | Out-Null

  try {
    # Node 22 or newer: the one on PATH, else a private copy from nodejs.org.
    $Node = ''
    $found = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
      try {
        $major = [int](& $found.Source -p "process.versions.node.split('.')[0]")
        if ($major -ge $NodeMajor) { $Node = $found.Source }
      } catch { }
    }
    if (-not $Node) {
      $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $arch = switch ($cpu) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { Fail ('unsupported processor ' + $cpu) } }
      Say ('installing Node.js ' + $NodeMajor + ' for Relo (nodejs.org)')
      $base = 'https://nodejs.org/dist/latest-v' + $NodeMajor + '.x/'
      Download ($base + 'SHASUMS256.txt') (Join-Path $Work 'SHASUMS256.txt')
      $line = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $Work 'SHASUMS256.txt')), '(?m)^([0-9a-f]{64})\s+(node-v[0-9.]+-win-' + $arch + '\.zip)\s*$')
      if (-not $line.Success) { Fail ('no Node.js ' + $NodeMajor + ' build for win-' + $arch) }
      $zip = Join-Path $Work $line.Groups[2].Value
      Download ($base + $line.Groups[2].Value) $zip
      if ((Sha256Of $zip) -ne $line.Groups[1].Value) { Fail 'the Node.js download did not match its checksum' }
      $unpacked = Join-Path $Work 'node'
      New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
      & $Tar -xf $zip -C $unpacked
      if ($LASTEXITCODE -ne 0) { Fail 'could not unpack Node.js' }
      $inner = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
      if (-not $inner -or -not (Test-Path -LiteralPath (Join-Path $inner.FullName 'node.exe'))) { Fail 'the Node.js download holds no node.exe' }
      if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
      Move-Item -LiteralPath $inner.FullName -Destination $NodeDir
      $Node = Join-Path $NodeDir 'node.exe'
    }

    Say ('installing the Relo CLI ' + $Version + ' from ' + $Origin)
    $tgz = Join-Path $Work 'relo-cli.tgz'
    Download ($Origin + '/cli/relo-cli.tgz') $tgz
    if ((Sha256Of $tgz) -ne $CliSha256) { Fail 'the CLI download did not match its checksum' }
    if (Test-Path -LiteralPath $CliDir) { Remove-Item -LiteralPath $CliDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $CliDir | Out-Null
    & $Tar -xzf $tgz -C $CliDir --strip-components=1
    if ($LASTEXITCODE -ne 0) { Fail 'could not unpack the CLI' }
    $Entry = Join-Path $CliDir 'bin\relo.mjs'
    if (-not (Test-Path -LiteralPath $Entry)) { Fail 'the CLI download holds no bin\relo.mjs' }

    # The launcher, in the format packages/cli/src/owner/windows-launcher.mjs writes and recognizes. One the Windows app wrote stays.
    $LauncherCmd = Join-Path $Bin 'relo.cmd'
    $LauncherSh = Join-Path $Bin 'relo'
    $existing = if (Test-Path -LiteralPath $LauncherCmd) { Get-Content -Raw -LiteralPath $LauncherCmd } else { '' }
    if ($existing -and $existing.Contains('Written by Relo for Windows')) {
      Say 'relo.cmd was written by Relo for Windows; it stays, and manages the CLI'
    } else {
      $crlf = [string][char]13 + [string][char]10
      $lf = [string][char]10
      WriteText $LauncherCmd ('@echo off' + $crlf + 'rem relo launcher: ' + $Entry + $crlf + '"' + $Node + '" "' + $Entry + '" %*' + $crlf)
      $nodeSlashed = $Node.Replace('\', '/')
      $entrySlashed = $Entry.Replace('\', '/')
      WriteText $LauncherSh ('#!/bin/sh' + $lf + '# relo launcher: ' + $entrySlashed + $lf + 'exec "' + $nodeSlashed + '" "' + $entrySlashed + '" "$@"' + $lf)
    }

    # The user Path (HKCU\Environment, Path): the raw value, so %VAR% entries survive; the machine Path is never touched.
    $Relo = 'relo'
    if (-not $SkipPath) {
      function Normal($entry) { [Environment]::ExpandEnvironmentVariables($entry.Trim()).Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      try {
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($raw.Split(';') | Where-Object { $_.Trim() -ne '' })
        if (-not ($entries | Where-Object { (Normal $_) -eq (Normal $Bin) })) {
          $key.SetValue('Path', (($entries + $Bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
          if (-not ('Relo.Native' -as [type])) {
            Add-Type -Namespace Relo -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
          }
          $result = [UIntPtr]::Zero
          [void][Relo.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
          Say 'added the Relo folder to your Path for new terminals'
        }
      } finally { $key.Close() }
      if (-not (($env:Path.Split(';') | Where-Object { $_ -ne '' }) | Where-Object { (Normal $_) -eq (Normal $Bin) })) { $env:Path = $env:Path + ';' + $Bin }
    } else {
      $Relo = $LauncherCmd
    }

    # Relo for Windows (-WindowsApp): the per-user installer from this server, checked against its digest, then opened signed in.
    $App = ''
    if ($WantApp) {
      if (-not $AppSha256) {
        Say 'this server has no Relo for Windows to install; skipped'
      } else {
        Say ('installing Relo for Windows ' + $AppVersion + ' from ' + $Origin)
        $setup = Join-Path $Work 'relo-setup.exe'
        Download ($Origin + '/windows/relo-setup.exe') $setup
        if ((Sha256Of $setup) -ne $AppSha256) { Fail 'the Relo for Windows download did not match its checksum' }
        $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Relo'
        # A copy of the app running from there is asked to close (then ended) so the installer can replace it.
        foreach ($proc in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($AppExecutable)) -ErrorAction SilentlyContinue)) {
          if ($proc.Path -and $proc.Path.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase)) {
            [void]$proc.CloseMainWindow()
            if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
          }
        }
        # /S: silent; /D= (last, unquoted) is the install folder. The installer is per user and asks for no elevation.
        $run = Start-Process -FilePath $setup -ArgumentList ('/S', ('/D=' + $AppDir)) -Wait -PassThru
        if ($run.ExitCode -ne 0) { Fail ('the Relo for Windows installer failed (exit ' + $run.ExitCode + ')') }
        $App = Join-Path $AppDir $AppExecutable
        if (-not (Test-Path -LiteralPath $App)) { Fail ('the Relo for Windows installer left no ' + $AppExecutable) }
      }
    }

    if (-not $Code) {
      if ($App) { Start-Process -FilePath $App -ArgumentList ('--relo-origin', $Origin) }
      # No code: the CLI only. Sign in with the link and QR code relo auth login shows, then set up the agents.
      Say ('installed. Next: ' + $Relo + ' auth login --api-url ' + $Origin + ', then ' + $Relo + ' setup')
      return
    }
    # Signs in with the code and runs relo setup the way the owner chose when making it.
    $join = @('auth', 'join', $Code, '--api-url', $Origin, '--client-name', $env:COMPUTERNAME)
    if ($App) { $join += @('--windows-app', $App) }
    & $LauncherCmd @join
    if ($LASTEXITCODE -ne 0) { Fail 'relo auth join did not finish' }
    Say 'done: this computer reports to Relo. Restart its agents so they load it.'
  } finally {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Install-Relo $args
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
