/**
 * Guest merge (migration *_guest_merge.sql, Edge Function `merge-guest`). When a guest signs in to an
 * account that already exists, what the guest made moves into that account instead of being left
 * behind: the guest asks for a one-time ticket before leaving for the provider, and the account
 * redeems it after signing in. The function moves the guest's map images, hands over its scenes and
 * hosted games, and deletes the empty guest.
 */
import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js"

import { getSupabase, NetError, toNetError, unwrap, type AtlasClient } from "./supabase"

export const MERGE_TICKET_RE = /^[A-Za-z0-9_-]{43}$/

export interface GuestMergeResult {
  scenes: number
  sessions: number
  images: number
}

/** As a guest: a ticket (valid 1 h) letting the account signed in next take over this guest. */
export async function createMergeTicket(client: AtlasClient = getSupabase()): Promise<string> {
  const ticket = unwrap(await client.rpc("create_merge_ticket"))
  if (typeof ticket !== "string" || !MERGE_TICKET_RE.test(ticket)) throw new NetError("unknown", "create_merge_ticket returned no ticket")
  return ticket
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * As the permanent account: move the ticket's guest into this account. Throws NetError: not_found
 * (ticket unknown, used or expired), forbidden, quota_exceeded / too_many_sessions (the two would not
 * fit in one account), not_authenticated, network, unknown (retryable).
 */
export async function mergeGuest(ticket: string, client: AtlasClient = getSupabase()): Promise<GuestMergeResult> {
  const { data, error } = await client.functions.invoke("merge-guest", { body: { ticket } })
  if (error) throw await mergeError(error)
  const d = (data ?? {}) as Record<string, unknown>
  return { scenes: count(d.scenes), sessions: count(d.sessions), images: count(d.images) }
}

async function mergeError(error: unknown): Promise<NetError> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response
    // Not the function's JSON (e.g. the function is not deployed): null.
    const body = (await response.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null
    if (body && typeof body.error === "string") {
      return toNetError({ message: body.error, details: typeof body.detail === "string" ? body.detail : undefined })
    }
    return new NetError("unknown", `merge-guest failed (HTTP ${response.status})`, { cause: error })
  }
  if (error instanceof FunctionsFetchError) return new NetError("network", error.message, { cause: error })
  return toNetError(error)
}
