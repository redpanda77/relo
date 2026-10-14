// Small helpers shared by every server-rendered Dashboard handler.

export function dashboardReleaseIdentity(value: string | undefined): string {
  const configured = value?.trim();
  return configured && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configured) ? configured : "dev";
}

export function pageNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export const dashboardContentSecurityPolicy =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Sends a Dashboard document with the shared CSP, no caching and no MIME sniffing. */
export function secureHtml(context: any, html: string): Response {
  context.header("content-security-policy", dashboardContentSecurityPolicy);
  context.header("cache-control", "private, no-store");
  context.header("x-content-type-options", "nosniff");
  return context.html(html);
}

/** Resolves the signed-in account, or redirects to sign-in and back to this page. */
export async function accountOrRedirect<Account>(
  context: any,
  getAccount: (headers: Headers) => Promise<Account | null>,
): Promise<Account | Response> {
  const account = await getAccount(context.req.raw.headers);
  return account ?? context.redirect(`/sign-in?next=${encodeURIComponent(context.req.path)}`);
}

export function isoDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]!);
}
