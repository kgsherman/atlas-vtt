/**
 * createServices(): the app-wide services, created once at startup (ServicesProvider).
 *
 * Cloud ("supabase"): Supabase identity (ensureIdentity: the signed-in account, else an anonymous
 * guest), remote repositories, private
 * Realtime channels, Supabase Storage assets. Local ("local", no configuration or `?local=1`):
 * per-tab identity, IndexedDB library, BroadcastChannel transport (dev/testing only, NOT secure).
 *
 * Throws NetError from identity resolution (anonymous_disabled, network, rate_limited, …); the
 * provider turns that into an actionable error screen.
 */
import { createAssetStore, createTileSource } from "@/net/assets"
import type { AssetStore, BackdropTileSource } from "@/net/assets/types"
import {
  ensureIdentity,
  localIdentity,
  setDisplayName as setProfileDisplayName,
  setLocalDisplayName,
  signOut as authSignOut,
  type AtlasIdentity,
} from "@/net/auth"
import { createLocalFreeAssetsRepo, createRemoteFreeAssetsRepo } from "@/net/freeAssets"
import { createBackgroundRemover } from "@/net/imageTools"
import { getLocalStore, type LocalStore } from "@/net/localStore"
import { createMergeTicket, mergeGuest } from "@/net/guestMerge"
import { createLocalTransport } from "@/net/localTransport"
import { createLocalScenesRepo, createRemoteScenesRepo } from "@/net/scenesRepo"
import { createLocalSessionsRepo, createRemoteSessionsRepo } from "@/net/sessionsRepo"
import { createLocalWorldsRepo, createRemoteWorldsRepo } from "@/net/worldsRepo"
import { getSupabase, NetError, type AtlasClient } from "@/net/supabase"
import { createSupabaseTransport } from "@/net/supabaseTransport"
import { createLocalTokenImageStore, createRemoteTokenImageStore } from "@/net/tokenImages"

import { beginAccountRedirect } from "./account"
import { currentMode, type AppMode } from "./mode"
import type { AppServices } from "./services"

export interface CreateServicesOptions {
  /** Default: currentMode() (Supabase when configured, unless `?local=1`). */
  mode?: AppMode
  /** Local store override (tests). Default: the app-wide IndexedDB store. */
  store?: LocalStore
}

/**
 * Local mode keeps the display name per tab, like its per-tab user id: tabs that play different
 * players must not all be pre-filled with the name last used in any tab.
 */
const TAB_NAME_KEY = "atlas-vtt:tab-display-name"

function readTabName(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TAB_NAME_KEY) ?? null
  } catch {
    return null
  }
}

function writeTabName(name: string): void {
  try {
    globalThis.sessionStorage?.setItem(TAB_NAME_KEY, name)
  } catch {
    // Storage blocked: the name lasts for this page.
  }
}

export async function createServices(opts: CreateServicesOptions = {}): Promise<AppServices> {
  const mode = opts.mode ?? currentMode().mode
  const client: AtlasClient | null = mode === "supabase" ? getSupabase() : null
  const [base, store] = await Promise.all([mode === "supabase" ? ensureIdentity() : Promise.resolve(localIdentity()), opts.store ?? getLocalStore()])
  // A private copy: setDisplayName keeps it current for non-React consumers.
  const identity: AtlasIdentity = { ...base, mode }
  if (!client) identity.displayName = readTabName()

  const scenes = client ? createRemoteScenesRepo(client) : createLocalScenesRepo(store)
  const sessions = client ? createRemoteSessionsRepo(client) : createLocalSessionsRepo({ store, scenes, userId: () => identity.userId })
  const worlds = client ? createRemoteWorldsRepo(client) : createLocalWorldsRepo({ store, userId: () => identity.userId })
  const transport = client ? createSupabaseTransport(client) : createLocalTransport()
  const assets = safeAssetStore(mode, () => createAssetStore({ client, store, userId: identity.userId }))
  const freeAssets = client ? createRemoteFreeAssetsRepo(client) : createLocalFreeAssetsRepo()
  const tokenImages = client ? createRemoteTokenImageStore(client, identity.userId) : createLocalTokenImageStore()
  const backgroundRemover = createBackgroundRemover({ client, dev: import.meta.env.DEV })

  return {
    mode,
    identity,
    worlds,
    scenes,
    sessions,
    transport,
    assets,
    freeAssets,
    tokenImages,
    backgroundRemover,
    tilesFor(sessionId: string): BackdropTileSource {
      try {
        return createTileSource({ sessionId, userId: identity.userId, client, store })
      } catch (err) {
        console.warn("[atlas] backdrop tiles unavailable:", err)
        return { getTile: async () => null, dispose() {} }
      }
    },
    async setDisplayName(name: string): Promise<string> {
      const stored = client ? await setProfileDisplayName(name, client) : setLocalDisplayName(name)
      if (!client) writeTabName(stored)
      identity.displayName = stored
      return stored
    },
    async signIn(provider, opts = {}) {
      if (!client) throw new NetError("unsupported_offline", "accounts need Cloud mode")
      const intent = opts.intent ?? (identity.isAnonymous ? "link" : "sign_in")
      const mergeTicket = opts.bringGuest && intent === "sign_in" && identity.isAnonymous ? await createMergeTicket(client) : undefined
      await beginAccountRedirect(client, intent, provider, { silent: opts.silent, mergeTicket })
    },
    async mergeGuest(ticket) {
      if (!client) throw new NetError("unsupported_offline", "accounts need Cloud mode")
      return mergeGuest(ticket, client)
    },
    async signOut() {
      if (!client) throw new NetError("unsupported_offline", "accounts need Cloud mode")
      await authSignOut(client)
    },
  }
}

/**
 * The asset store, or (if it cannot be created) a stand-in whose operations fail with a clear
 * error, so a broken image store never takes the whole app down.
 */
function safeAssetStore(mode: AppMode, create: () => AssetStore): AssetStore {
  try {
    return create()
  } catch (err) {
    console.warn("[atlas] map image storage unavailable:", err)
    const reason = err instanceof Error ? err.message : String(err)
    const fail = (): Promise<never> => Promise.reject(new NetError("unknown", `map image storage is unavailable (${reason})`))
    return {
      mode,
      putImage: fail,
      getImage: fail,
      deleteImage: fail,
      copyImages: fail,
      putTileChunk: fail,
      deleteTileChunks: fail,
      removeSessionTiles: fail,
      deleteSceneImages: fail,
      sweepUnreferencedImages: fail,
    }
  }
}
