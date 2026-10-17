// The --secret-file writer: reserves a new private file before the secret exists, writes the secret alone into
// it, and truncates it if anything changed in between. Used for every one-time secret the CLI receives.
import { lstat, open } from "node:fs/promises";
import { ApiError, UsageError } from "./errors.mjs";

async function assertSecretFileAvailable(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new UsageError("--secret-file requires a path");
  }
  try {
    const existing = await lstat(path);
    const kind = existing.isSymbolicLink() ? "symlink" : existing.isFile() ? "file" : "non-regular path";
    throw new UsageError(`Refusing to overwrite an existing ${kind} with --secret-file`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function reserveSecretFile(path) {
  await assertSecretFileAvailable(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new UsageError("Refusing a --secret-file path that appeared during reservation");
    }
    throw error;
  }
  const info = await handle.stat();
  return {
    path,
    handle,
    identity: { dev: info.dev, ino: info.ino },
  };
}

function sameFile(info, identity) {
  return info.dev === identity.dev && info.ino === identity.ino;
}

async function assertReservationPathIdentity(reservation, message) {
  try {
    const current = await lstat(reservation.path);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, reservation.identity)) {
      throw new UsageError(message);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new UsageError(message);
    throw error;
  }
}

export async function releaseSecretFileReservation(reservation) {
  await reservation.handle?.close().catch(() => {});
}

/**
 * Writes the secret alone (plus a newline) into the reserved file. `format` is the shape the server promised
 * (for example /^hook_[A-Za-z0-9_-]{43}$/u); `what` names the secret in errors ("service secret").
 */
export async function writeReservedSecretFile(reservation, secret, { format, what }) {
  if (typeof secret !== "string" || !format.test(secret)) {
    throw new ApiError(`The server's response did not include a valid ${what}.`, {
      code: "INVALID_API_RESPONSE",
    });
  }
  const contents = Buffer.from(`${secret}\n`, "utf8");
  let wrote = false;
  try {
    const current = await reservation.handle.stat();
    if (
      !current.isFile() || current.isSymbolicLink()
      || !sameFile(current, reservation.identity) || current.nlink !== 1 || current.size !== 0
    ) {
      throw new UsageError("Refusing to write a changed --secret-file reservation");
    }
    await assertReservationPathIdentity(
      reservation,
      "Refusing to write a changed --secret-file reservation",
    );
    const result = await reservation.handle.write(contents, 0, contents.length, 0);
    wrote = true;
    if (result.bytesWritten !== contents.length) {
      throw new ApiError(`The ${what} file write was incomplete.`, {
        code: "SECRET_FILE_WRITE_FAILED",
      });
    }
    await reservation.handle.sync();
    await assertReservationPathIdentity(
      reservation,
      "Refusing a changed --secret-file after writing",
    );
    const finalReservation = await reservation.handle.stat();
    if (
      !finalReservation.isFile() || finalReservation.isSymbolicLink()
      || !sameFile(finalReservation, reservation.identity)
      || finalReservation.nlink !== 1 || finalReservation.size !== contents.length
    ) {
      throw new UsageError("Refusing a changed --secret-file after writing");
    }
  } catch (error) {
    if (wrote) {
      await reservation.handle.truncate(0).catch(() => {});
      await reservation.handle.sync().catch(() => {});
    }
    throw error;
  }
}
