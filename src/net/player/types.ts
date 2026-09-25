/**
 * Contract for the player-side client (ARCHITECTURE §6.3). The play page creates one PlayerClient,
 * subscribes to its snapshot and sends move/door requests.
 */
import type { PathStep } from "@/core/movement/types"
import type { Id, SceneLike, Vec2 } from "@/core/scene/types"
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
  /** The DM closed the table: disconnected until it opens again (the page starts a new client then). */
  | "closed"
  | "ended"
  | "error"

export interface PendingRequest {
  reqId: string
  kind: "move" | "jump" | "door" | "say" | "roll" | "initiative" | "end-turn" | "token-status" | "token-image" | "template" | "template-remove"
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
  /**
   * Backdrop tiles for explored cells (Supabase storage with RLS, or local). A source with `setMap` (local
   * mode's crops from the stored scene) is told the map of each view (scene.mapSerial ?? 0) before its tiles
   * are asked for.
   */
  tiles: BackdropTileSource & { setMap?(mapSerial: number): void }
}

export interface PlayerClient {
  start(): Promise<void>
  stop(): Promise<void>
  getSnapshot(): PlayerSnapshot
  subscribe(listener: () => void): () => void
  /** Returns the reqId; the pending overlay clears when the result/patch arrives or after 5 s. */
  /** `end`: the exact final point of a gridless move (PlayerView flags.freeMovement). */
  requestMove(tokenId: Id, path: PathStep[], end?: Vec2 | null): string
  /** Put a token at a point without walking there (when no path can be found). */
  requestJump(tokenId: Id, levelId: Id, position: Vec2): string
  requestDoor(doorId: Id, action: "open" | "close"): string
  /** Put an image from the player's token image folder on a controlled token (null clears it). */
  requestTokenImage(tokenId: Id, imageUrl: string | null): string
}

export type CreatePlayerClient = (opts: PlayerClientOptions) => PlayerClient
