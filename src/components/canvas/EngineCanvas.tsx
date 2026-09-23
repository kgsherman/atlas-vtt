/**
 * Hosts one render Engine on a <canvas> that fills its parent. Children (HTML overlays, viewport
 * controllers) read the engine through useEngine(). The engine is created on mount and disposed on
 * unmount; `quality` changes are applied live.
 */
import * as React from "react"

import { createEngine, type Engine, type Quality } from "@/render"
import { cn } from "@/lib/utils"

import { EngineContext, type EngineContextValue } from "./engineContext"

export interface EngineCanvasProps {
  quality?: Quality
  className?: string
  /** Called once the engine exists (and with null when it is disposed). */
  onEngine?: (engine: Engine | null) => void
  children?: React.ReactNode
}

export function EngineCanvas({ quality, className, onEngine, children }: EngineCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [value, setValue] = React.useState<EngineContextValue>({ engine: null, canvas: null })
  const [error, setError] = React.useState<string | null>(null)
  const onEngineRef = React.useRef(onEngine)
  const initialQuality = React.useRef(quality)

  React.useEffect(() => {
    onEngineRef.current = onEngine
  }, [onEngine])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let created: Engine
    try {
      created = createEngine(canvas, { quality: initialQuality.current })
    } catch (err) {
      queueMicrotask(() => setError(err instanceof Error ? err.message : String(err)))
      return
    }
    queueMicrotask(() => {
      setValue({ engine: created, canvas })
      onEngineRef.current?.(created)
    })
    return () => {
      onEngineRef.current?.(null)
      created.dispose()
    }
  }, [])

  React.useEffect(() => {
    if (value.engine && quality) value.engine.setQuality(quality)
  }, [value.engine, quality])

  return (
    <EngineContext.Provider value={value}>
      <div className={cn("relative size-full overflow-hidden bg-black", className)}>
        <canvas ref={canvasRef} data-slot="engine-canvas" className="block size-full touch-none outline-none" tabIndex={0} />
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            WebGL2 is required to render maps. {error}
          </div>
        ) : null}
        {children}
      </div>
    </EngineContext.Provider>
  )
}
