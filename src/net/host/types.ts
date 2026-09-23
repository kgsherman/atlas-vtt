/**
 * Contract for the DM-side host runner (ARCHITECTURE §6). The DM's session page creates one
 * HostRunner, subscribes to its snapshot (useSyncExternalStore-friendly) and issues DM commands.
 */
import type { Patch } from "immer"

import type { ReduceResult } from "@/core/session/state"
import type { DmCommand, GameState } from "@/core/session/types"
import type { Id } from "@/core/scene/types"
import type { VisibilityResult } from "@/core/vision/types"
import type { AtlasIdentity } from "../auth"
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
  /** Wire epoch (random per host start). */
  epoch: string | null
  state: GameState | null
  members: HostMember[]
  stats: HostStats
}

export interface HostRunnerOptions {
  sessionId: string
  transport: Transport
  /** Sessions repository (Supabase or local). */
  repo: SessionsRepo
  identity: AtlasIdentity
  /** Map image assets (backdrop tiles for players). */
  assets: AssetStore
  /** Create the vision worker (injectable for tests; default spawns src/net/host/visionWorker.ts). */
  createVisionClient?: () => VisionClient
}

/** Minimal async facade over the vision worker (also implementable in-thread for tests). */
export interface VisionClient {
  setScene(scene: GameState["scene"], stateSeq: number): Promise<void>
  update(scene: GameState["scene"], change: { objects?: Id[]; tokens?: Id[]; structure?: boolean; terrain?: Id[] }, stateSeq: number): Promise<void>
  /** Visibility for a set of viewer token ids against the scene at stateSeq. */
  compute(viewerTokenIds: Id[], stateSeq: number): Promise<{ stateSeq: number; result: VisibilityResult }>
  dispose(): void
}

export interface HostRunner {
  start(): Promise<void>
  /** Stop hosting (keeps the session active; players see "Waiting for DM"). */
  stop(): Promise<void>
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
  /** Editor edits during the live session (immer patches against GameState.scene). */
  applyScenePatches(patches: Patch[]): void
  /** DM "preview token vision": visibility for these tokens against the live scene (no knowledge update). */
  previewVisibility(tokenIds: Id[]): Promise<VisibilityResult>
  /** Kick (status kicked + remove-player + {t:"kicked"}). */
  kick(userId: string): Promise<void>
  /** Persist immediately (fenced). */
  save(): Promise<void>
  /** End the session for everyone. */
  endSession(): Promise<void>
}

export type CreateHostRunner = (opts: HostRunnerOptions) => HostRunner
