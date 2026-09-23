/**
 * App-wide services (created once at startup after auth). Pages read them with useServices().
 * Implemented by createServices() in ./createServices.ts.
 */
import * as React from "react"

import type { AccountProvider, AtlasIdentity } from "@/net/auth"
import type { AssetStore, BackdropTileSource } from "@/net/assets/types"
import type { ScenesRepo } from "@/net/scenesRepo"
import type { SessionsRepo } from "@/net/sessionsRepo"
import type { Transport } from "@/net/transport"

export interface AppServices {
  /** "supabase" when VITE_SUPABASE_* are configured, else "local" (IndexedDB + BroadcastChannel, dev only). */
  mode: "supabase" | "local"
  identity: AtlasIdentity
  scenes: ScenesRepo
  sessions: SessionsRepo
  transport: Transport
  assets: AssetStore
  /** Player-side backdrop tile source for a session. */
  tilesFor(sessionId: string): BackdropTileSource
  /** Update the display name (profiles / local identity); returns the normalised name. */
  setDisplayName(name: string): Promise<string>
  /**
   * Cloud only (else unsupported_offline): leave for the provider to make this guest a permanent
   * account (`link`, same user id) or to switch to an existing account (`sign_in`). See app/account.ts.
   */
  signIn(provider: AccountProvider, opts?: { intent?: "link" | "sign_in"; silent?: boolean }): Promise<void>
  /** Cloud only: sign out of this browser; the app restarts as a new guest. */
  signOut(): Promise<void>
}

export const ServicesContext = React.createContext<AppServices | null>(null)

export function useServices(): AppServices {
  const s = React.useContext(ServicesContext)
  if (!s) throw new Error("useServices() outside <ServicesContext.Provider>")
  return s
}
