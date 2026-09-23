/**
 * Public API of net/host: the DM-side authoritative host runner (ARCHITECTURE §6.1–§6.3, §9) and its
 * vision client. The session page creates one runner per hosted session:
 *
 *   const host = createHostRunner({ sessionId, transport, repo, identity, assets })
 *   await host.start()
 *   const snap = useSyncExternalStore(host.subscribe, host.getSnapshot)
 */
import { HostRunnerImpl, type CreateHostRunnerOptions } from "./hostRunner"
import type { CreateHostRunner } from "./types"

export type * from "./types"
export type { CreateHostRunnerOptions, HostRunnerInternalOptions, HostTiming, LockManagerLike } from "./hostRunner"
export { HostRunnerImpl } from "./hostRunner"
export { createDefaultVisionClient, createInThreadVisionClient, createWorkerVisionClient, type VisionClientExt, type WorkerLike } from "./visionClient"
export { createCanvasTileCodec, type TileCodec, type TileCrop, type TileImage } from "./tiles"
export { hostEpochOfWire, HOST_TIMING, makeWireEpoch } from "./flush"

/** Create the host runner (satisfies CreateHostRunner; extra options are for tests and tuning). */
export function createHostRunner(opts: CreateHostRunnerOptions): HostRunnerImpl {
  return new HostRunnerImpl(opts)
}

// Compile-time check: createHostRunner satisfies the module contract (src/net/host/types.ts).
const _contract: CreateHostRunner = createHostRunner
void _contract
