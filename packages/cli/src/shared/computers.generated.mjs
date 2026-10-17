// Generated from packages/contracts/src/computers.ts by packages/contracts/scripts/generated.ts. Do not edit:
// change the source, then run `pnpm --filter @relo/notification-contracts generate`.
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}

export const COMPUTER_ICONS = deepFreeze([
  "laptop",
  "desktop",
  "server",
  "cloud",
  "terminal",
  "build"
]);
