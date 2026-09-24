import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

import { imageToolsApi } from "./dev/imageToolsApi.ts"

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Dev-only /api endpoints read server-side secrets (e.g. OPENAI_API_KEY) from .env* files; they are
  // not VITE_-prefixed, so they never reach the client bundle.
  plugins: [react(), tailwindcss(), imageToolsApi({ ...loadEnv(mode, process.cwd(), ""), ...process.env })],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
}))
