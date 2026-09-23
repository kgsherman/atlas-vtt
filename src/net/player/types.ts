/**
 * Contract for the player-side client (ARCHITECTURE §6.3). The play page creates one PlayerClient,
 * subscribes to its snapshot and sends move/door requests.
 */
import type { PathStep } from "@/core/movement/types"
import type { Id, SceneLike } from "@/core/scene/types"
import type { PlayerView, RequestResult } from "@/core/session/types"
import type { AtlasIdentity } from "../auth"
import type { SessionsRepo } from "../sessionsRepo"
import type { Transport } from "../transport"
import type { BackdropTileSource } from "../assets/types"

export type PlayerStatus =
  | "connecting"
  /** Channels up, waiting for the first snapshot. */
  | "syncing"
  | "live"
  /** No DM presence: showing the persisted player_views row, input disabled. */
  | "host-offline"
  | "kicked"
  | "ended"
  | "error"

export interface PendingRequest {
  reqId: string
  kind: "move" | "door"
  tokenId?: Id
  path?: PathStep[]
  doorId?: Id
  sentAt: number
}

export interface PlayerSnapshot {
  status: PlayerStatus
  error: string | null
  sessionId: string
  userId: string
  view: PlayerView | null
  /** viewToScene(view), memoised per view revision (feed to Engine.setScene/updateScene). */
  scene: SceneLike | null
  /** Bumps whenever view changes (for effects). */
  revision: number
  epoch: string | null
  seq: number
  hostOnline: boolean
  /** Optimistic overlays only (never merged into the view). */
  pending: PendingRequest[]
  /** Most recent request results (newest last, capped). */
  results: RequestResult[]
}

export interface PlayerClientOptions {
  sessionId: string
  transport: Transport
  repo: SessionsRepo
  identity: AtlasIdentity
  /** Backdrop tiles for explored cells (Supabase storage with RLS, or local). */
  tiles: BackdropTileSource
}

export interface PlayerClient {
  start(): Promise<void>
  stop(): Promise<void>
  getSnapshot(): PlayerSnapshot
  subscribe(listener: () => void): () => void
  /** Returns the reqId; the pending overlay clears when the result/patch arrives or after 5 s. */
  requestMove(tokenId: Id, path: PathStep[]): string
  requestDoor(doorId: Id, action: "open" | "close"): string
}

export type CreatePlayerClient = (opts: PlayerClientOptions) => PlayerClient
