import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Tauri loads http://localhost:1420 in dev (tauri.conf.json devUrl) and ../dist in a build.
// Two pages: the notch (index.html) and the Settings / onboarding window (settings.html).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        home: resolve(import.meta.dirname, "home.html"),
      },
    },
  },
})
