/** PKCE (RFC 7636, S256) and the sign-in state, with WebCrypto. The verifier never leaves the device until the token exchange. */

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(crypto: Crypto = globalThis.crypto): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string, crypto: Crypto = globalThis.crypto): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function createPkce(crypto: Crypto = globalThis.crypto): Promise<Pkce> {
  const verifier = randomToken(crypto);
  return { verifier, challenge: await challengeFor(verifier, crypto), state: randomToken(crypto) };
}

export async function sha256Hex(text: string, crypto: Crypto = globalThis.crypto): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
