/**
 * createServices(): the app-wide services, created once at startup (ServicesProvider).
 *
 * Cloud ("supabase"): anonymous Supabase identity (ensureIdentity), remote repositories, private
 * Realtime channels, Supabase Storage assets. Local ("local", no configuration or `?local=1`):
 * per-tab identity, IndexedDB library, BroadcastChannel transport (dev/testing only, NOT secure).
 *
 * Throws NetError from identity resolution (anonymous_disabled, network, rate_limited, …); the
 * provider turns that into an actionable error screen.
 */
import { createAssetStore, createTileSource } from "@/net/assets"
import type { AssetStore, BackdropTileSource } from "@/net/assets/types"
import { ensureIdentity, localIdentity, setDisplayName as setProfileDisplayName, setLocalDisplayName, type AtlasIdentity } from "@/net/auth"
import { getLocalStore, type LocalStore } from "@/net/localStore"
import { createLocalTransport } from "@/net/localTransport"
import { createLocalScenesRepo, createRemoteScenesRepo } from "@/net/scenesRepo"
import { createLocalSessionsRepo, createRemoteSessionsRepo } from "@/net/sessionsRepo"
import { getSupabase, NetError, type AtlasClient } from "@/net/supabase"
import { createSupabaseTransport } from "@/net/supabaseTransport"

import { currentMode, type AppMode } from "./mode"
import type { AppServices } from "./services"

export interface CreateServicesOptions {
  /** Default: currentMode() (Supabase when configured, unless `?local=1`). */
  mode?: AppMode
  /** Local store override (tests). Default: the app-wide IndexedDB store. */
  store?: LocalStore
}

export async function createServices(opts: CreateServicesOptions = {}): Promise<AppServices> {
  const mode = opts.mode ?? currentMode().mode
  const client: AtlasClient | null = mode === "supabase" ? getSupabase() : null
  const [base, store] = await Promise.all([mode === "supabase" ? ensureIdentity() : Promise.resolve(localIdentity()), opts.store ?? getLocalStore()])
  // A private copy: setDisplayName keeps it current for non-React consumers.
  const identity: AtlasIdentity = { ...base, mode }

  const scenes = client ? createRemoteScenesRepo(client) : createLocalScenesRepo(store)
  const sessions = client ? createRemoteSessionsRepo(client) : createLocalSessionsRepo({ store, scenes, userId: () => identity.userId })
  const transport = client ? createSupabaseTransport(client) : createLocalTransport()
  const assets = safeAssetStore(mode, () => createAssetStore({ client, store, userId: identity.userId }))

  return {
    mode,
    identity,
    scenes,
    sessions,
    transport,
    assets,
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
      identity.displayName = stored
      return stored
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
      publishTiles: fail,
      grantTiles: fail,
    }
  }
}
