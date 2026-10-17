// Generated from packages/contracts/src/scopes.ts by packages/contracts/scripts/generated.ts. Do not edit:
// change the source, then run `pnpm --filter @relo/notification-contracts generate`.
function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}

export const SCOPES = deepFreeze({
  "notifications:send": {
    "means": "Send notices to the owner's phones.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "interactions:create": {
    "means": "Ask questions and approvals.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "interactions:read": {
    "means": "Read, wait on and stream the answers to its questions.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "activities:write": {
    "means": "Start, update and finish works and their cards.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "activities:read": {
    "means": "Read works, Now and the sessions list.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "devices:read": {
    "means": "List the account's phones and delivery evidence.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "services:read": {
    "means": "List webhook services and computer credentials.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "services:write": {
    "means": "Create, rotate and revoke webhook services and computer credentials.",
    "kinds": [
      "login",
      "ci-token"
    ]
  },
  "device:self": {
    "means": "A phone manages its own registration, keys and tokens.",
    "kinds": [
      "device"
    ]
  },
  "inbox:read": {
    "means": "A phone reads the owner's inbox and current state.",
    "kinds": [
      "device"
    ]
  },
  "interactions:respond": {
    "means": "A phone answers questions and approvals.",
    "kinds": [
      "device"
    ]
  },
  "presence:write": {
    "means": "Hooks report a session's observed phase, nothing else.",
    "kinds": [
      "harness"
    ]
  },
  "hooks:notify": {
    "means": "A service sends notices and questions and manages its own events.",
    "kinds": [
      "service"
    ]
  },
  "hooks:cards": {
    "means": "A service starts, updates and ends its own cards.",
    "kinds": [
      "service"
    ]
  },
  "hooks:works": {
    "means": "A service starts, updates and finishes its own works.",
    "kinds": [
      "service"
    ]
  },
  "hooks:read": {
    "means": "A service reads its own events and answers.",
    "kinds": [
      "service"
    ]
  }
});

export const LOGIN_SCOPES = deepFreeze([
  "notifications:send",
  "interactions:create",
  "interactions:read",
  "activities:write",
  "activities:read",
  "devices:read",
  "services:read",
  "services:write"
]);
