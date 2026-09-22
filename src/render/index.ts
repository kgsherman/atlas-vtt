/**
 * Render entry point. STUB — implemented by the render-engine module.
 */
import type { CreateEngine } from "./contracts"

export type * from "./contracts"

export const createEngine: CreateEngine = () => {
  throw new Error("createEngine: not implemented")
}
