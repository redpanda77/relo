import { z } from "zod";

export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      hostname.endsWith(".home") || hostname.endsWith(".lan") ||
      (!hostname.includes(".") && !hostname.includes(":"))
    ) return false;

    const ipv4 = hostname.split(".").map(Number);
    if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [first, second] = ipv4;
      if (
        first === 0 || first === 10 || first === 127 ||
        (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && (second === 0 || second === 168)) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && ipv4[2] === 100) ||
        (first === 203 && second === 0 && ipv4[2] === 113) ||
        (first !== undefined && first >= 224)
      ) return false;
    }

    const isIpv6 = hostname.includes(":");
    return !(isIpv6 && (
      hostname === "::" || hostname === "::1" ||
      hostname.startsWith("fc") || hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) || hostname.startsWith("ff") ||
      hostname.startsWith("2001:db8:") || hostname.startsWith("::ffff:")
    ));
  } catch {
    return false;
  }
}

export const publicHttpsUrlSchema = z.url().max(2_048)
  .refine(isPublicHttpsUrl, "Must be a public HTTPS URL");
export const httpsUrlSchema = z.url().max(2_048).startsWith("https://");
