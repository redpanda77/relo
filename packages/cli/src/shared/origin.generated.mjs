// Generated from packages/contracts/src/origin.ts by packages/contracts/scripts/generated.ts. Do not edit:
// change the source, then run `pnpm --filter @relo/notification-contracts generate`.
/**
 * Is this address private (plan 10 M7.5)? One classifier for the server (which origins may use plain HTTP, whether
 * it is on a public address) and the CLI (strict mode's default, public-only URLs), generated into the CLI as
 * packages/cli/src/shared/origin.generated.mjs. Plain code with no imports, so the copy is a straight transpile.
 * Private: loopback, link-local, RFC 1918, carrier-grade NAT (100.64/10, where Tailscale lives), unique-local
 * IPv6, documentation and benchmarking ranges, multicast and unspecified addresses, and names that never resolve
 * publicly (localhost, *.localhost, *.local, *.internal, *.home.arpa).
 */
export function isPrivateHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host))
        return true;
    const octets = host.split(".");
    if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
        const [a, b, c] = octets.map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 192 && b === 0 && (c === 0 || c === 2))
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113);
    }
    if (host.includes(":")) {
        return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("ff")
            || host.startsWith("2001:db8:") || host.startsWith("::ffff:");
    }
    return false;
}
/** Whether a URL's host is reachable from the internet (not private by the rule above). Not a URL: false. */
export function isPublicOrigin(url) {
    try {
        return !isPrivateHost(new URL(url).hostname);
    }
    catch {
        return false;
    }
}
