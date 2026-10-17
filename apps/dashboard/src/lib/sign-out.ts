import { revokeCurrentBrowser } from "@/lib/e2ee/browser-link"
import { forgetBrowserKeys } from "@/lib/e2ee/keys"

/**
 * Signs this browser out: revokes its linked-browser record, ends the session on the server, and
 * forgets its keys even if the server's sign-out fails, so nothing it could read stays readable.
 * The caller navigates away afterwards.
 */
export async function signOutThisBrowser(): Promise<void> {
  await revokeCurrentBrowser()
  try {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    if (!response.ok) throw new Error("Sign out failed")
  } finally {
    await forgetBrowserKeys()
  }
}
