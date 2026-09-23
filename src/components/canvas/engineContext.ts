import * as React from "react"

import type { Engine } from "@/render"

export interface EngineContextValue {
  engine: Engine | null
  canvas: HTMLCanvasElement | null
}

export const EngineContext = React.createContext<EngineContextValue>({ engine: null, canvas: null })

/** The engine of the nearest EngineCanvas (null until created). */
export function useEngine(): EngineContextValue {
  return React.useContext(EngineContext)
}
