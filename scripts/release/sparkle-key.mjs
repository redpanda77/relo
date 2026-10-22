#!/usr/bin/env node
// Sparkle's EdDSA update key as a file, never in a keychain (a keychain read can wait on an invisible prompt).
//
//   node scripts/release/sparkle-key.mjs init      write a fresh key (refuses to overwrite) and print the public key
//   node scripts/release/sparkle-key.mjs public    print the public key (RELO_SPARKLE_PUBLIC_KEY) of the existing file
//
// The file holds the base64 of the 32-byte Ed25519 seed, the format of `sign_update --ed-key-file`. Default path
// ~/.config/relo/sparkle/ed25519.key (RELO_SPARKLE_KEY_FILE), mode 0600 in a 0700 folder.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX_LENGTH = 12;

export const defaultKeyFile = (env = process.env) =>
  env.RELO_SPARKLE_KEY_FILE || join(homedir(), ".config", "relo", "sparkle", "ed25519.key");

export function initKey(file) {
  if (existsSync(file)) throw new Error(`${file} exists: not overwriting a signing key`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const seed = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  writeFileSync(file, `${seed.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  return publicKey(file);
}

const privateKeyOf = (file) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(readFileSync(file, "utf8").trim(), "base64")]), format: "der", type: "pkcs8" });

export function publicKey(file) {
  return createPublicKey(privateKeyOf(file)).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX_LENGTH).toString("base64");
}

export const signBytes = (file, bytes) => sign(null, bytes, privateKeyOf(file)).toString("base64");

export function verifyBytes(publicKeyBase64, bytes, signatureBase64) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyBase64, "base64")]);
  return verify(null, bytes, createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(signatureBase64, "base64"));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command] = process.argv.slice(2);
  const file = defaultKeyFile();
  try {
    if (command === "init") { console.error(`wrote ${file}`); console.log(initKey(file)); }
    else if (command === "public") console.log(publicKey(file));
    else throw new Error("usage: sparkle-key.mjs init|public");
  } catch (error) { console.error(`sparkle-key: ${error.message}`); process.exit(1); }
}
