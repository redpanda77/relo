// URL options: https links, tap destinations, answer callbacks, public https endpoints.
import { UsageError } from "./errors.mjs";
import { isPrivateHost } from "./origin.generated.mjs";

export function validateHttpsUrl(value, name) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`--${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new UsageError(`--${name} must use HTTPS`);
  if (parsed.toString().length > 2_048) throw new UsageError(`--${name} must be at most 2048 characters`);
  return parsed.toString();
}

const BLOCKED_DESTINATION_SCHEMES = new Set([
  "http", "javascript", "vbscript", "data", "file", "blob", "about", "filesystem", "content",
]);

/** Tap destinations: https:// links, an app's own scheme (your-app://...), or shortcuts://. */
export function validateDestinationUrl(value, name) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new UsageError(`--${name} must be a valid URL`, {
      hint: "Use https://..., an app link such as your-app://path, or shortcuts://run-shortcut?name=...",
    });
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) || BLOCKED_DESTINATION_SCHEMES.has(scheme)
    || parsed.username || parsed.password || (scheme === "https" && !parsed.hostname)
    || text.length <= scheme.length + 1) {
    throw new UsageError(`--${name} cannot use ${scheme}: links`, {
      hint: "Use https://..., an app link such as your-app://path, or shortcuts://run-shortcut?name=...",
    });
  }
  if (text.length > 2_048) throw new UsageError(`--${name} must be at most 2048 characters`);
  return scheme === "https" ? parsed.toString() : text;
}

/**
 * Where an answer callback may go: https anywhere, or http on a private network; never the
 * server's own localhost. Whether a private address is allowed is the server admin's setting.
 */
export function validateCallbackUrl(value, name) {
  let url;
  try { url = new URL(String(value)); } catch { throw new UsageError(`--${name} must be a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`--${name} must use https:// (or http:// on a private network)`);
  if (url.username || url.password || url.hash) throw new UsageError(`--${name} cannot carry credentials or a #fragment`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || /^127\./u.test(host) || host === "::1" || host === "0.0.0.0"
    || /^169\.254\./u.test(host)) {
    throw new UsageError(`--${name} cannot be the server's own localhost or a link-local address`, {
      hint: "Use an address the Relo server can reach, such as its hostname or LAN address",
    });
  }
  if (String(value).length > 2048) throw new UsageError(`--${name} is longer than 2,048 characters`);
  return url.toString();
}

export function validatePublicHttpsUrl(value, name) {
  const normalized = validateHttpsUrl(value, name);
  if (normalized === undefined) return undefined;
  // One rule with the server for what is private (packages/contracts/src/origin.ts).
  if (isPrivateHost(new URL(normalized).hostname)) throw new UsageError(`--${name} must use a public HTTPS URL`);
  return normalized;
}
