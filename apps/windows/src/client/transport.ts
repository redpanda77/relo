// How the app reaches a Relo server.
//
// The page's origin is http://tauri.localhost (a build) or http://localhost:1420 (dev). The server answers its API
// without any CORS headers (apps/server has no Access-Control-* anywhere: its web routes refuse cross-origin requests
// outright and its device routes are for native clients), and every owner-client request carries `Authorization`, which
// makes the browser preflight first. So `window.fetch` cannot work from the webview, whatever the server's address.
//
// The calls therefore go through Rust: tauri-plugin-http's `fetch` has the same shape as `window.fetch` (streaming
// bodies and abort included, which the live events stream needs), sends no `Origin`, and is limited by the scope in
// src-tauri/capabilities/default.json (https anywhere, plain http only to this machine).

import { fetch as rustFetch } from "@tauri-apps/plugin-http"
import type { FetchLike } from "@relo/owner-client"
import { inTauri } from "../bridge"

export const appFetch: FetchLike = inTauri
  ? (input, init) => rustFetch(input, init)
  : (input, init) => globalThis.fetch(input, init)
