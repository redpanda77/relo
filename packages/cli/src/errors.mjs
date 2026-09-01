export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  API: 1,
  AUTH: 3,
  TERMINAL: 4,
  NEGATIVE: 5,
  NETWORK: 6,
  NO_DELIVERY: 7,
});

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
    super(message, {
      code: negative ? "NEGATIVE_RESPONSE" : "INTERACTION_TERMINAL",
      exitCode: negative ? EXIT.NEGATIVE : EXIT.TERMINAL,
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
