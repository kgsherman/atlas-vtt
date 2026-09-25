/**
 * Contract for the DM-side host runner (ARCHITECTURE §6). The DM's session page creates one
 * HostRunner, subscribes to its snapshot (useSyncExternalStore-friendly) and issues DM commands.
 */
import type { Patch } from "immer"

import type { TablePing } from "@/core/session/filter"
import type { ReduceResult } from "@/core/session/state"
import type { DmCommand, GameState } from "@/core/session/types"
import type { Id, Vec2 } from "@/core/scene/types"
import type { VisibilityResult } from "@/core/vision/types"
import type { AtlasIdentity } from "../auth"
import type { ScenesRepo } from "../scenesRepo"
import type { SessionsRepo } from "../sessionsRepo"
import type { Transport } from "../transport"
import type { AssetStore } from "../assets/types"

export type HostStatus =
  /** Claiming the host epoch, loading state, opening channels. */
  | "starting"
  /** This tab is the authoritative host. */
  | "hosting"
  /** Another tab/device holds the host lock or a higher epoch; read-only until takeOver(). */
  | "standby"
  | "ended"
  | "error"

export interface HostMember {
  userId: string
  displayName: string
  status: "active" | "kicked"
  /** Lobby presence (display only). */
  online: boolean
  /** Both req and view channels SUBSCRIBED from the host side. */
  linked: boolean
  /** Last acknowledged per-player view seq. */
  seq: number
}

export interface HostStats {
  /** Last vision compute time in the worker (ms). */
  visionMs: number
  /** Last flush (filter + diff + send) time for all dirty players (ms). */
  flushMs: number
  messagesSent: number
  bytesSent: number
  pendingSends: number
  lastSaveAt: number | null
}

export interface HostSnapshot {
  status: HostStatus
  error: string | null
  sessionId: string
  roomCode: string
  /** The table's doors are open (sessions.status "active"): members may join and connect. */
  tableOpen: boolean
  /** Wire epoch (random per host start and per opening of the table; null while closed or not hosting). */
  epoch: string | null
  state: GameState | null
  members: HostMember[]
  stats: HostStats
  /**
   * The library scene the live map comes from (GameState.origin): its row id, the version the map is
   * based on (its last restore point; null = unknown, e.g. a game saved before this was recorded) and
   * whether the map changed since (edits and play actions). null: none (the library scene was deleted).
   */
  library: { sceneId: string; version: number | null; dirty: boolean } | null
}

/** A ping seen by the host: a player's (`from`: their user id) or the DM's own (`from`: null). */
export interface HostPingEvent {
  ping: TablePing
  from: string | null
}

export interface HostRunnerOptions {
  sessionId: string
  transport: Transport
  /** Sessions repository (Supabase or local). */
  repo: SessionsRepo
  identity: AtlasIdentity
  /** Map image assets (backdrop tiles for players). */
  assets: AssetStore
  /** The DM's scene library (saveMapToLibrary). Without it the live map cannot be saved back. */
  scenes?: ScenesRepo
  /**
   * Public URL prefix of the token image store (TokenImageStore.publicBase): players may put images from
   * their own folder there on their tokens (`token-image` requests). Absent / null: they cannot.
   */
  tokenImageBase?: string | null
  /** Create the vision worker (injectable for tests; default spawns src/net/host/visionWorker.ts). */
  createVisionClient?: () => VisionClient
}

/** Minimal async facade over the vision worker (also implementable in-thread for tests). */
export interface VisionClient {
  setScene(scene: GameState["scene"], stateSeq: number): Promise<void>
  update(scene: GameState["scene"], change: { objects?: Id[]; tokens?: Id[]; structure?: boolean; terrain?: Id[] }, stateSeq: number): Promise<void>
  /** Visibility for a set of viewer token ids against the scene at stateSeq. */
  compute(viewerTokenIds: Id[], stateSeq: number): Promise<{ stateSeq: number; result: VisibilityResult }>
  /**
   * Low-priority "what if": visibility of each viewer set on the current revision with `change` taken
   * from `scene` (e.g. a moving token at an intermediate step of its path), without adopting it (the
   * client's revision and tag stay as they are). Probes wait until no setScene/update/compute is
   * outstanding and run one at a time, so a foreground call waits for at most one probe. `stateSeq`
   * is the tag of the revision the probe was applied to. A probe whose `opts.cancelled()` is true by
   * the time it would start is skipped: it resolves with no results (and `stateSeq` -1).
   */
  probe(
    scene: GameState["scene"],
    change: { objects?: Id[]; tokens?: Id[] },
    viewerSets: Id[][],
    opts?: { cancelled?: () => boolean }
  ): Promise<{ stateSeq: number; results: VisibilityResult[] }>
  /** Probes queued or running. */
  readonly pendingProbes: number
  dispose(): void
}

export interface HostRunner {
  start(): Promise<void>
  /** Stop hosting (keeps the table as it is; players at an open table see "Waiting for DM"). */
  stop(): Promise<void>
  /**
   * Open or close the table's doors (ARCHITECTURE §6.8). Closed: players are told and disconnected, the
   * host keeps running without channels, the room code stays reserved. Open: members connect again.
   */
  setTableOpen(open: boolean): Promise<void>
  /** Steal the host lock / claim a new epoch after standby. */
  takeOver(): Promise<void>
  getSnapshot(): HostSnapshot
  subscribe(listener: () => void): () => void
  /**
   * DM commands (move token, doors, lights, locks, shared vision, assign tokens, reveal, fog reset…).
   * Returns the reducer's result (its `error` explains a refused command, e.g. for a toast), or null
   * when this tab is not hosting.
   */
  dispatch(cmd: DmCommand): ReduceResult | null
  /** Editor edits on the map screen (immer patches against GameState.scene). */
  applyScenePatches(patches: Patch[]): void
  /** DM "preview token vision": visibility for these tokens against the live scene (no knowledge update). */
  previewVisibility(tokenIds: Id[]): Promise<VisibilityResult>
  /** Kick (status kicked + remove-player + {t:"kicked"}). */
  kick(userId: string): Promise<void>
  /** Persist immediately (fenced). */
  save(): Promise<void>
  /**
   * Save the live map (as it is now, edits made during the session included) as a new version of the
   * library scene the session was started from. Rejects with NetError("version_conflict") when that
   * scene got another version meanwhile (retry with `force` to overwrite), and with "not_found" when it
   * was deleted. Works after endSession() too. Resolves with the new version number (the map's newest
   * restore point).
   */
  saveMapToLibrary(opts?: { force?: boolean }): Promise<number>
  /** End the table for good (players disconnected, the room code released). */
  endSession(): Promise<void>
  /**
   * Point at a spot for every player who knows its level (filter.ts pingForPlayer). `focus`: ask their
   * clients to centre the camera on it. Ephemeral: nothing is stored.
   */
  ping(levelId: Id, point: Vec2, opts?: { focus?: boolean }): void
  /** Pings as they happen: players' (to show the DM) and the DM's own. */
  onPing(cb: (ev: HostPingEvent) => void): () => void
}

export type CreateHostRunner = (opts: HostRunnerOptions) => HostRunner
