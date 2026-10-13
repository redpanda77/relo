import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The header a reverse proxy in front of Relo writes the real client address into, such as
 * `cf-connecting-ip` behind Cloudflare Tunnel or `x-real-ip` behind nginx. Set once at startup from
 * RELO_CLIENT_IP_HEADER. Without it every request is attributed to its transport peer, which behind
 * a proxy is the proxy itself, so per-client limits collapse into one shared bucket.
 */
let trustedHeader: string | undefined;

export function trustClientAddressHeader(header: string | undefined): void {
  trustedHeader = header?.trim().toLowerCase() || undefined;
}

/**
 * The address to attribute a request to. The configured header is believed only when the
 * transport peer is a loopback or private address (the proxy on this host or its container
 * network); a request that reaches the listener directly from elsewhere cannot spoof it.
 */
export function clientAddress(context?: Context): string | undefined {
  if (!context) return undefined;
  let peer: string | undefined;
  try {
    peer = getConnInfo(context).remote.address;
  } catch {
    // Hono's in-memory request harness has no transport socket. Production uses the Node adapter.
    return undefined;
  }
  if (!peer) return undefined;
  if (trustedHeader && isPrivatePeer(peer)) {
    const forwarded = context.req.header(trustedHeader)?.split(",")[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return peer;
}

export function isPrivatePeer(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 127 || first === 10 || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168);
  }
  if (isIP(value) === 6) return value === "::1" || /^f[cd]/.test(value);
  return false;
}
