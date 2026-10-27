/**
 * Every exit code, once: the name code uses, what it means (relo schema) and the short form help prints.
 * An answer is 0 (yes), 5 (no), 4 (still open: resume) or 8 (closed without an answer: never act).
 */
/** Each exit code: its name, its meaning (help and `relo schema`), a short form, and `doc`, the row the README and the skill print. */
export const EXIT_CODES = Object.freeze([
  { code: 0, name: "OK", meaning: "success, approved, yes, chosen, or replied", short: "ok/approved/yes/chosen", doc: "Success, or the owner approved / said yes" },
  { code: 1, name: "API", meaning: "server or other failure", short: "server", doc: "Server or other failure" },
  { code: 2, name: "USAGE", meaning: "usage error", short: "usage", doc: "Usage error or refused: read the `Next` line" },
  { code: 3, name: "AUTH", meaning: "authentication or scope", short: "auth (relo auth login)", doc: "Missing, invalid, or insufficient credential (`relo auth login`)" },
  { code: 4, name: "TERMINAL", meaning: "still open: this command stopped waiting (resume with relo interaction wait ID)", short: "still open (resume)", doc: "Still open: this command stopped waiting. Run `relo interaction wait ID`" },
  { code: 5, name: "NEGATIVE", meaning: "denied or no", short: "denied/no", doc: "The owner denied or said no" },
  { code: 6, name: "NETWORK", meaning: "network", short: "network", doc: "Network unreachable: retry the same command" },
  { code: 7, name: "NO_DELIVERY", meaning: "no phone accepted the push", short: "no phone or Mac got it", doc: "Nothing could show it: no phone and no Mac" },
  { code: 8, name: "CLOSED", meaning: "closed without an answer (expired or canceled): do not act", short: "closed, no answer (do not act)", doc: "Closed without an answer (expired, canceled): do not act" },
]);

export const EXIT = Object.freeze(Object.fromEntries(EXIT_CODES.map(({ name, code }) => [name, code])));

/** { code: meaning }, as relo schema publishes it. */
export const exitCodeMeanings = () => Object.fromEntries(EXIT_CODES.map(({ code, meaning }) => [code, meaning]));

/** "0 ok/approved/yes · 5 denied/no", for the codes given, in that order. */
export const exitCodeLine = (codes, separator = " · ") => codes.map((code) => `${code} ${EXIT_CODES[code].short}`).join(separator);

/** What to tell an owner whose remote server needs encryption and has no iPhone to encrypt for (one wording everywhere). */
/** A local account is linked by the app that runs Relo on this machine: Relo for Mac on a Mac, Relo for Windows on a PC. */
const ON_WINDOWS = process.platform === "win32";
export const LOCAL_RELINK = ON_WINDOWS ? "Open Relo; it links this PC again." : "Open Relo for Mac; it links this Mac again.";
export const LOCAL_NOT_LINKED = ON_WINDOWS ? "Relo isn't linked yet: open Relo." : "Relo for Mac isn't linked yet: open Relo for Mac.";
export const NO_PHONE_ENCRYPTION_HINT = "This server requires encryption and has no iPhone to encrypt for: add your iPhone, or set encryption to Automatic in the Dashboard.";

export class ReloError extends Error {
  constructor(message, { code = "INTERNAL_ERROR", exitCode = EXIT.API, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends ReloError {
  constructor(message, details) {
    super(message, { code: "USAGE_ERROR", exitCode: EXIT.USAGE, details });
  }
}

export class AuthError extends ReloError {
  constructor(message, { code = "AUTH_REQUIRED", details } = {}) {
    super(message, { code, exitCode: EXIT.AUTH, details });
  }
}

export class NetworkError extends ReloError {
  constructor(message, details) {
    super(message, { code: "NETWORK_ERROR", exitCode: EXIT.NETWORK, details });
  }
}

export class ApiError extends ReloError {
  constructor(message, { status = 0, code = "API_ERROR", details } = {}) {
    super(message, {
      code,
      exitCode: status === 401 || status === 403 ? EXIT.AUTH : EXIT.API,
      details: { status, ...details },
    });
    this.status = status;
  }
}

export class TerminalInteractionError extends ReloError {
  constructor(message, { state, details } = {}) {
    const negative = state === "denied" || state === "no";
    // "timeout" is this command's own wait running out: the question is still open (4).
    const open = state === "timeout";
    super(message, {
      code: negative ? "NEGATIVE_RESPONSE" : open ? "INTERACTION_TERMINAL" : "INTERACTION_CLOSED",
      exitCode: negative ? EXIT.NEGATIVE : open ? EXIT.TERMINAL : EXIT.CLOSED,
      details: { state, ...details },
    });
  }
}

export class NoDeliveryError extends ReloError {
  constructor(message = "No durable device command was enqueued.", details) {
    super(message, { code: "NO_ACCEPTED_DELIVERY", exitCode: EXIT.NO_DELIVERY, details });
  }
}

export function normalizeError(error) {
  if (error instanceof ReloError) return error;
  return new ReloError(error instanceof Error ? error.message : "Unexpected failure");
}
