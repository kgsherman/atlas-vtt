/**
 * LIVE test of the guest merge against the configured Supabase project (.env.local): the migration
 * *_guest_merge.sql and the deployed `merge-guest` Edge Function. Skipped unless ATLAS_LIVE_SUPABASE=1:
 *
 *   ATLAS_LIVE_SUPABASE=1 npx vitest run src/net/guestMerge.live.supabase.test.ts
 *
 * A guest makes a scene, uploads a map image and hosts a game, takes a merge ticket; a permanent
 * (email sign-up) account redeems it. It checks the account got everything, the image moved and the
 * guest is gone, then removes the scene, image and game. The permanent test user it created is
 * printed so it can be deleted (auth.users is not reachable with the publishable key).
 */
import { afterAll, describe, expect, it } from "vitest"

import { createSupabaseAssetStore } from "./assets/supabaseAssets"
import { ensureSession, setDisplayName } from "./auth"
import { readSupabaseEnv } from "./env"
import { createMergeTicket, mergeGuest } from "./guestMerge"
import { createAtlasClient, type AtlasClient } from "./supabase"

const env = readSupabaseEnv()
// Read through globalThis: the app tsconfig has no Node typings.
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const enabled = nodeEnv.ATLAS_LIVE_SUPABASE === "1" && env !== null

describe.skipIf(!enabled)("live Supabase: guest merge", () => {
  const cleanups: Array<() => Promise<unknown>> = []
  let accountId = ""

  const newClient = (): AtlasClient => createAtlasClient(env!, { worker: false, persistSession: false })

  afterAll(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined)
    console.info(`[live test] permanent test user to delete: ${accountId}`)
  })

  it("moves a guest's scene, image and game into the account it signs in to, then deletes the guest", async () => {
    // ---- the guest makes things
    const guest = newClient()
    const guestIdentity = await ensureSession(guest)
    expect(guestIdentity.isAnonymous).toBe(true)
    await setDisplayName("Merge Guest", guest)
    const docId = `doc${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
    const { data: sceneId, error: sceneError } = await guest.rpc("create_scene", { p_name: "Merged scene", p_schema_version: 1, p_data: { id: docId } })
    expect(sceneError).toBeNull()
    const image = new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" })
    const asset = await createSupabaseAssetStore(guest, guestIdentity.userId).putImage(docId, image, {
      kind: "image",
      name: "map",
      mime: "image/webp",
      width: 1,
      height: 1,
    })
    const { data: session, error: sessionError } = await guest.rpc("create_session", { p_scene_id: sceneId as string })
    expect(sessionError).toBeNull()
    const sessionId = (session as Array<{ session_id: string }>)[0]!.session_id
    const ticket = await createMergeTicket(guest)

    // ---- a permanent account (email sign-up is auto-confirmed on this project)
    const account = newClient()
    const signUp = await account.auth.signUp({ email: `atlas-merge-${crypto.randomUUID()}@example.com`, password: `${crypto.randomUUID()}Aa1!` })
    expect(signUp.error).toBeNull()
    accountId = signUp.data.user!.id
    expect(signUp.data.user!.is_anonymous).toBe(false)
    cleanups.push(async () => {
      await account.rpc("end_session", { p_session_id: sessionId })
      await account.from("sessions").delete().eq("id", sessionId)
      await account.storage.from("scene-assets").remove([`${accountId}/${docId}/${asset.id}.webp`])
      await account
        .from("scenes")
        .delete()
        .eq("id", sceneId as string)
    })

    // ---- redeem
    expect(await mergeGuest(ticket, account)).toEqual({ scenes: 1, sessions: 1, images: 1 })

    const { data: scenes } = await account.from("scenes").select("id, owner_id")
    expect(scenes).toEqual([{ id: sceneId, owner_id: accountId }])
    const { data: sessions } = await account.from("sessions").select("id, dm_id, status")
    expect(sessions).toEqual([{ id: sessionId, dm_id: accountId, status: "active" }])
    const { data: profile } = await account.from("profiles").select("display_name").eq("id", accountId).maybeSingle()
    expect(profile?.display_name).toBe("Merge Guest")
    const moved = await account.storage.from("scene-assets").download(`${accountId}/${docId}/${asset.id}.webp`)
    expect(moved.error).toBeNull()
    expect(moved.data?.size).toBe(image.size)

    // The guest is gone, and the ticket cannot be replayed.
    const gone = await guest.auth.getUser()
    expect(gone.data.user).toBeNull()
    await expect(mergeGuest(ticket, account)).rejects.toMatchObject({ code: "not_found" })
  }, 60_000)
})
