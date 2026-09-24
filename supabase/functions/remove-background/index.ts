// Atlas VTT: remove the background of an image with the configured image model (ARCHITECTURE §11,
// migration *_token_maker.sql, supabase/functions/_shared/imageModels.ts).
//
// POST multipart/form-data { image: PNG | JPEG | WebP, width, height } with the caller's session JWT.
// Answers { image: base64, mime, model } (a PNG with a transparent background) or { error, detail }.
//
// Every call spends from a daily allowance (consume_image_tool_quota: per user, lower for guests, and a
// global cap), because each one costs money at the model provider and guests are free to create.
// The provider key lives in the function's secrets (OPENAI_API_KEY, …), never in the client.
//
// Deployed with verify_jwt = false: user tokens are ES256 (signing keys), so the caller is checked
// here with auth.getUser(), which asks the Auth server.
import { createClient } from "npm:@supabase/supabase-js@2"

import { backgroundRemovalModel, errorBody, ImageToolError, imageResult, readImageForm } from "../_shared/imageModels.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })
}

function failure(err: unknown): Response {
  const { status, body } = errorBody(err)
  if (status >= 500) console.error("remove-background:", body.detail)
  return json(body, status)
}

function secretKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS")
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>
    if (parsed.default) return parsed.default
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!legacy) throw new Error("no secret key in the environment")
  return legacy
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ error: "invalid_argument", detail: "POST only" }, 405)

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (!jwt) throw new ImageToolError("not_authenticated", "missing session token")

    // Configuration before anything is spent.
    const model = backgroundRemovalModel((name) => Deno.env.get(name))

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: caller, error: authError } = await admin.auth.getUser(jwt)
    if (authError || !caller.user) throw new ImageToolError("not_authenticated", "invalid session token")

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      throw new ImageToolError("invalid_argument", "expected a multipart/form-data body")
    }
    const input = await readImageForm(form)

    const quota = await admin.rpc("consume_image_tool_quota", { p_user: caller.user.id, p_anonymous: caller.user.is_anonymous === true })
    if (quota.error) {
      if (quota.error.message === "quota_exceeded") throw new ImageToolError("quota_exceeded", quota.error.details || "the daily allowance is used up")
      throw new Error(`consume_image_tool_quota failed: ${quota.error.message}`)
    }

    const out = await model.removeBackground(input, req.signal)
    return json(imageResult(out, model.id))
  } catch (err) {
    return failure(err)
  }
})
