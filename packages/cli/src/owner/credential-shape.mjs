// The shapes `relo doctor` and `relo auth` check a server answer against (shared so neither imports the other).
import { ApiError } from "../shared/errors.mjs";

export function safeCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Authorization response did not include credential metadata.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (
    typeof value.id !== "string" ||
    typeof value.clientName !== "string" ||
    typeof value.prefix !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string")
  ) {
    throw new ApiError("Authorization response included invalid credential metadata.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return {
    id: value.id,
    clientName: value.clientName,
    prefix: value.prefix,
    scopes: [...value.scopes],
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.expiresAt === "string" || value.expiresAt === null
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(typeof value.lastUsedAt === "string" || value.lastUsedAt === null
      ? { lastUsedAt: value.lastUsedAt }
      : {}),
    ...(typeof value.revokedAt === "string" || value.revokedAt === null
      ? { revokedAt: value.revokedAt }
      : {}),
  };
}

export function isReadyResponse(value) {
  return value?.ready === true || value?.status === "ok" || value?.status === "ready";
}
