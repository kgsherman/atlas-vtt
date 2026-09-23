/** Public API of net/host. STUB — implemented by the net-host module. */
import type { CreateHostRunner } from "./types"

export type * from "./types"

export const createHostRunner: CreateHostRunner = () => {
  throw new Error("createHostRunner: not implemented")
}
