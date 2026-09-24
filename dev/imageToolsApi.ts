/**
 * Dev-only image tools endpoint (ARCHITECTURE §11): `npm run dev` serves
 * POST /api/image-tools/remove-background with the same model code as the Edge Function
 * (supabase/functions/_shared/imageModels.ts), reading the provider key from the dev server's env
 * (`OPENAI_API_KEY` in .env.local; never VITE_-prefixed, so it never reaches the browser bundle).
 * No auth and no quota: the dev server listens on localhost. Production builds do not include it;
 * there the client calls the Edge Function.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import type { Plugin } from "vite"

import { backgroundRemovalModel, errorBody, ImageToolError, imageResult, MAX_INPUT_BYTES, readImageForm } from "../supabase/functions/_shared/imageModels.ts"

export const REMOVE_BACKGROUND_PATH = "/api/image-tools/remove-background"

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new ImageToolError("payload_too_large", "the upload is too large")
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

export function imageToolsApi(env: Record<string, string | undefined>): Plugin {
  return {
    name: "atlas-image-tools-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(REMOVE_BACKGROUND_PATH, (req, res) => {
        void (async () => {
          try {
            if (req.method !== "POST") throw new ImageToolError("invalid_argument", "POST only")
            const model = backgroundRemovalModel((name) => env[name])
            const body = await readBody(req, MAX_INPUT_BYTES + 64 * 1024)
            const headers = new Headers()
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
            let form: FormData
            try {
              form = await new Request("http://localhost/", { method: "POST", headers, body: new Uint8Array(body) }).formData()
            } catch {
              throw new ImageToolError("invalid_argument", "expected a multipart/form-data body")
            }
            const input = await readImageForm(form)
            const started = Date.now()
            const out = await model.removeBackground(input)
            server.config.logger.info(`[image-tools] ${model.id} removed a background in ${((Date.now() - started) / 1000).toFixed(1)} s`)
            send(res, 200, imageResult(out, model.id))
          } catch (err) {
            const { status, body } = errorBody(err)
            if (status >= 500 && body.error !== "not_configured") server.config.logger.error(`[image-tools] ${body.detail}`)
            send(res, status, body)
          }
        })()
      })
    },
  }
}
