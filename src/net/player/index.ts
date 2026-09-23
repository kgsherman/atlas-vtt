/** Public API of net/player. STUB — implemented by the net-player module. */
import type { CreatePlayerClient } from "./types"

export type * from "./types"

export const createPlayerClient: CreatePlayerClient = () => {
  throw new Error("createPlayerClient: not implemented")
}
