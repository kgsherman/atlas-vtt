// Atlas VTT: merge a guest account into the caller's permanent account (ARCHITECTURE §6.4 Identity,
// migration *_guest_merge.sql).
//
// POST { ticket } with the account's session JWT. The ticket came from create_merge_ticket(), called
// by the guest before it signed in to the account. Steps (each retryable until the last SQL step):
//   1. begin_guest_merge: validate the ticket, check the combined quotas, list the guest's map images;
//   2. move each image {guest}/{doc}/{asset} → {account}/{doc}/{asset} (Storage API; SQL can't);
//   3. finish_guest_merge: hand over scenes and hosted games, consume the ticket;
//   4. delete the guest user (its sign-in is gone from the browser; nothing it owned is left).
//
// Deployed with verify_jwt = false: user tokens are ES256 (signing keys), so the caller is checked
// here with auth.getUser(), which asks the Auth server.
import { createClient } from "npm:@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const BUCKET = "scene-assets"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })
}

function fail(code: string, detail: string, status: number): Response {
  return json({ error: code, detail }, status)
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

/** Postgres `raise exception '<code>'` from the RPCs: the code is the message. */
function rpcFailure(error: { message?: string; details?: string | null }): Response {
  const code = error.message ?? "unknown"
  const status = code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "quota_exceeded" || code === "too_many_sessions" ? 409 : 400
  return fail(code, error.details ?? "", status)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return fail("invalid_argument", "POST only", 405)

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
  if (!jwt) return fail("not_authenticated", "missing session token", 401)

  let ticket: unknown
  try {
    ticket = ((await req.json()) as { ticket?: unknown }).ticket
  } catch {
    return fail("invalid_argument", "expected a JSON body", 400)
  }
  if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return fail("invalid_argument", "malformed merge ticket", 400)

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: caller, error: authError } = await admin.auth.getUser(jwt)
  if (authError || !caller.user) return fail("not_authenticated", "invalid session token", 401)
  if (caller.user.is_anonymous) return fail("forbidden", "sign in to a permanent account first", 403)
  const target = caller.user.id

  // 1. validate + quotas + what to move
  const begun = await admin.rpc("begin_guest_merge", { p_token: ticket, p_target: target })
  if (begun.error) return rpcFailure(begun.error)
  const { guest_id: guest, objects } = begun.data as { guest_id: string; objects: string[] }

  // 2. move the images; the owner folder is the first path segment
  let moved = 0
  for (const from of objects) {
    if (!from.startsWith(`${guest}/`)) continue
    const to = `${target}/${from.slice(guest.length + 1)}`
    const { error } = await admin.storage.from(BUCKET).move(from, to)
    if (!error) {
      moved++
      continue
    }
    // Already there (an earlier attempt, or the same document in both accounts): keep the account's copy.
    if (/exist/i.test(error.message)) {
      const removed = await admin.storage.from(BUCKET).remove([from])
      if (!removed.error) continue
    }
    console.error("merge-guest: move failed", from, error.message)
    return fail("unknown", "could not move the guest's map images; try again", 502)
  }

  // 3. hand over the rows, consume the ticket
  const finished = await admin.rpc("finish_guest_merge", { p_token: ticket, p_target: target })
  if (finished.error) return rpcFailure(finished.error)
  const { scenes, sessions } = finished.data as { scenes: number; sessions: number }

  // 4. the guest is empty now: remove it (and its leftover memberships in other DMs' games)
  const deleted = await admin.auth.admin.deleteUser(guest)
  if (deleted.error) console.error("merge-guest: could not delete the guest", guest, deleted.error.message)

  return json({ scenes, sessions, images: moved })
})
