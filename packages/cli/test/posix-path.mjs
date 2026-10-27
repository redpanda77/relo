// Tests write expected paths POSIX-style ("/home/owner/.claude/CLAUDE.md"), but the code builds them with
// node:path, so on Windows they come back with backslashes (and a drive letter when resolved). `posix`
// normalizes an ACTUAL path to the POSIX spelling (a no-op on POSIX), so one literal serves both.
export const posix = (path) => (path === undefined || path === null ? path : String(path).replace(/^[A-Za-z]:(?=[\\/])/u, "").replaceAll("\\", "/"));
// Setup prints home-relative paths as "~/.claude/skills" on POSIX and "~\\.claude\\skills" on Windows (the
// owner reads the platform's own spelling); tests compare the POSIX one, so a result is normalized deeply.
// "~\\.claude\\skills" inside any text becomes "~/.claude/skills".
export const tildeText = (text) => String(text).replace(/~(?:[\\/][^\s"',;)]*)+/gu, (path) => path.replaceAll("\\", "/"));
export const tildePosix = (value) => {
  if (typeof value === "string") return tildeText(value);
  if (Array.isArray(value)) return value.map(tildePosix);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tildePosix(item)]));
  return value;
};
export const posixAll = (paths) => paths.map(posix);
