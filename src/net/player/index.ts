/**
 * Public API of net/player (ARCHITECTURE §6.3, §9): the player-side client.
 *
 *   const client = createPlayerClient({ sessionId, transport, repo, identity, tiles })
 *   await client.start()
 *   useSyncExternalStore(client.subscribe, client.getSnapshot)   // status, view, scene, pending, results
 *   const unbind = bindBackdropsToEngine(client, engine)          // battlemap canvases → engine
 *   client.requestMove(tokenId, path) / client.requestDoor(doorId, "open")
 *   await client.stop()                                           // also disposes `tiles`
 */
import { createAtlasPlayerClient, type AtlasPlayerClient, type PlayerClientRuntimeOptions } from "./playerClient"
import type { CreatePlayerClient } from "./types"

export type * from "./types"
export {
  bindBackdropsToEngine,
  buildPlayerScene,
  describeRequestResult,
  isOtherMap,
  parseStoredView,
  pendingMovesOverlay,
  PLAYER_CLIENT_TIMINGS,
  sceneChangeFromOps,
  type AtlasPlayerClient,
  type ClientClock,
  type ClientRequestResult,
  type LocalRejectReason,
  type PlayerClientRuntimeOptions,
  type PlayerClientSnapshot,
  type PlayerClientTimings,
} from "./playerClient"
export {
  BACKDROP_DEFAULTS,
  BackdropCompositor,
  backdropLayout,
  cellPixelRect,
  exploredCellsInRect,
  type BackdropCanvas,
  type BackdropCompositorOptions,
  type BackdropEvent,
  type BackdropLayer,
  type BackdropLayout,
  type BackdropStats,
} from "./backdropCanvas"

/** Create the player client (a PlayerClient with backdrop compositing and engine helpers). */
export function createPlayerClient(opts: PlayerClientRuntimeOptions): AtlasPlayerClient {
  return createAtlasPlayerClient(opts)
}

// The richer signature still satisfies the shared contract.
void (createPlayerClient satisfies CreatePlayerClient)
