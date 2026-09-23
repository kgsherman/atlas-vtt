/**
 * The host's vision Worker (ARCHITECTURE §6.2, PERFORMANCE §8): authoritative visibility off the
 * render thread. Spawned by visionClient.ts with
 * `new Worker(new URL("./visionWorker.ts", import.meta.url), { type: "module" })`.
 * Messages are handled strictly in order, so a compute always runs on the latest posted revision.
 */
import { responseTransferables, VisionWorkerCore, type VisionRequest, type VisionResponse } from "./visionProtocol"

interface WorkerScope {
  onmessage: ((ev: MessageEvent<VisionRequest>) => void) | null
  postMessage(message: VisionResponse, transfer: Transferable[]): void
}

const scope = self as unknown as WorkerScope
const core = new VisionWorkerCore()

scope.onmessage = (ev) => {
  const res = core.handle(ev.data)
  const transfer = responseTransferables(res)
  scope.postMessage(res, transfer)
}
