// Script and app producers (plan 04 §2.9): a producer key names a script's work so later commands find it.
import { createHash } from "node:crypto";
import { WorkRefusal } from "../work/refusal.mjs";

export const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** The readable key from --producer, else RELO_SESSION (via the caller); `--name` is refused (D11). */
export function resolveProducer(options, caller) {
  if (options.name !== undefined) {
    throw new WorkRefusal("NAME_REFUSED", { what: "--name is gone; a script names its work with --producer KEY", state: "no producer key", next: "relo work start --producer <name-of-this-job> --goal \"…\" --idempotency-key \"…\"" });
  }
  const key = options.producer ?? caller?.session ?? caller?.producerKey;
  if (key === undefined || key === true || key === "") {
    throw new WorkRefusal("PRODUCER_REQUIRED", {
      what: "a script names its work with --producer KEY (or RELO_SESSION=KEY), so later commands find it",
      state: "no session id, no producer key",
      next: 'relo work start --producer <name-of-this-job> --goal "…" --idempotency-key "…"',
    });
  }
  if (!PRODUCER_KEY_PATTERN.test(String(key))) {
    throw new WorkRefusal("PRODUCER_INVALID", { what: "a producer key is 1-100 of A-Z a-z 0-9 . _ : -", state: `producer "${String(key).slice(0, 40)}"`, next: "relo work start --producer deploy-bot --goal \"…\"" });
  }
  return String(key);
}

/** The path segment: sha256("producer:"+KEY), base64url, 43 characters. */
export function producerPathKey(key) {
  return createHash("sha256").update(`producer:${key}`).digest("base64url");
}
