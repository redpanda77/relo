export const LINK_TITLE = "Read encrypted items in this browser"
export const LINK_STEPS = "Open Relo on your iPhone → Settings → Devices → Link a browser"

/** The text a trusted iPhone scans to link this browser (docs/ENCRYPTION-PROTOCOL.md). */
export function linkPayload(browserId: string, identityKey: string) {
  return `relo-link:1:${browserId}:${identityKey}`
}
