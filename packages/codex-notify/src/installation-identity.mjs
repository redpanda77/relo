import { createHash,randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link,open,unlink } from "node:fs/promises";
import { basename,dirname,isAbsolute,join } from "node:path";

const RAW_ID_BYTES = 32;
const RAW_ID_PATTERN = /^v1:([a-f0-9]{64})\n$/u;
const STORE_MODE = 0o600;

export class InstallationIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallationIdentityError";
  }
}

function invalidStore() {
  return new InstallationIdentityError("Installation identity store is invalid.");
}

function derivedSourceInstance(rawIdentifier) {
  const digest = createHash("sha256")
    .update(`relo-codex-notify:source-instance:v1\u0000${rawIdentifier}`)
    .digest("hex")
    .slice(0,32);
  return `codex-notify-${digest}`;
}

async function readStoredIdentity(path,{ openImpl = open,uid = process.getuid?.() } = {}) {
  let handle;
  try {
    handle = await openImpl(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw invalidStore();
    if (process.platform !== "win32" && (info.mode & 0o777) !== STORE_MODE) throw invalidStore();
    if (process.platform !== "win32" && uid !== undefined && info.uid !== uid) throw invalidStore();
    if (info.size !== Buffer.byteLength(`v1:${"0".repeat(64)}\n`,"utf8")) throw invalidStore();
    const match = RAW_ID_PATTERN.exec(await handle.readFile("utf8"));
    if (!match) throw invalidStore();
    return derivedSourceInstance(match[1]);
  } catch (error) {
    if (error instanceof InstallationIdentityError || error?.code === "ENOENT") throw error;
    throw new InstallationIdentityError("Unable to read installation identity store.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function randomHex(bytes,randomBytesImpl) {
  const value = randomBytesImpl(bytes);
  if (!Buffer.isBuffer(value) || value.length !== bytes) {
    throw new InstallationIdentityError("Unable to generate installation identity.");
  }
  return value.toString("hex");
}

export async function loadOrCreateInstallationIdentity(path,dependencies = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new InstallationIdentityError("Installation identity path must be absolute.");
  }
  const openImpl = dependencies.openImpl ?? open;
  const linkImpl = dependencies.linkImpl ?? link;
  const unlinkImpl = dependencies.unlinkImpl ?? unlink;
  const randomBytesImpl = dependencies.randomBytesImpl ?? randomBytes;
  const readOptions = { openImpl,uid: dependencies.uid ?? process.getuid?.() };
  try {
    return await readStoredIdentity(path,readOptions);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const rawIdentifier = randomHex(RAW_ID_BYTES,randomBytesImpl);
  const temporary = join(dirname(path),`.${basename(path)}.${process.pid}.${randomHex(8,randomBytesImpl)}.tmp`);
  let handle;
  let ownsTemporary = false;
  try {
    handle = await openImpl(temporary,"wx",STORE_MODE);
    ownsTemporary = true;
    await handle.chmod(STORE_MODE);
    await handle.writeFile(`v1:${rawIdentifier}\n`,"utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await linkImpl(temporary,path);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new InstallationIdentityError("Unable to persist installation identity store.");
      }
    }
  } catch (error) {
    if (error instanceof InstallationIdentityError) throw error;
    throw new InstallationIdentityError("Unable to persist installation identity store.");
  } finally {
    await handle?.close().catch(() => {});
    if (ownsTemporary) await unlinkImpl(temporary).catch(() => {});
  }
  return readStoredIdentity(path,readOptions);
}
