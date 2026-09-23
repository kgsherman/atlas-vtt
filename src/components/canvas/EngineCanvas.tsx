/**
 * Hosts one render Engine on a <canvas> that fills its parent. Children (HTML overlays, viewport
 * controllers) read the engine through useEngine(). The engine is created on mount and disposed on
 * unmount; `quality` changes are applied live.
 *
 * `quality` undefined at mount means Auto: the device probe (render pickInitialQuality: renderer
 * heuristics + a short benchmark, cached per GPU for 30 days) picks the starting tier, which is also the adaptive
 * ceiling, the backdrop texel cap and whether the WebGL context gets MSAA. Those are fixed when the
 * engine is created, so the probe runs first; to switch back to Auto, remount (e.g. via `key`).
 */
import * as React from "react"

import { ServicesContext } from "@/app/services"
import {
  cachedQuality,
  createEngine,
  pickInitialQuality,
  type Engine,
  type Quality,
  type TokenModelSource,
} from "@/render"
import { cn } from "@/lib/utils"

import { EngineContext, type EngineContextValue } from "./engineContext"

export interface EngineCanvasProps {
  /** Explicit tier; undefined (at mount) = Auto, chosen by the device probe. */
  quality?: Quality
  className?: string
  /** Called once the engine exists (and with null when it is disposed). */
  onEngine?: (engine: Engine | null) => void
  /**
   * The engine's quality ceiling once known: the probed tier on Auto, else the explicit tier (and again
   * whenever the `quality` prop changes).
   */
  onQualityCeiling?: (q: Quality) => void
  children?: React.ReactNode
}

/** Tier used when the probe fails. */
const FALLBACK_QUALITY: Quality = "medium"

let inflightProbe: Promise<Quality> | null = null

/**
 * One device probe at a time: StrictMode double-mounts and several canvases mounting together share
 * it. It only runs without a fresh cache entry (see cachedQuality).
 */
function probeInitialQuality(
  cssWidth?: number,
  cssHeight?: number
): Promise<Quality> {
  inflightProbe ??= pickInitialQuality({ cssWidth, cssHeight })
    .catch(() => FALLBACK_QUALITY)
    .finally(() => {
      inflightProbe = null
    })
  return inflightProbe
}

export function EngineCanvas({
  quality,
  className,
  onEngine,
  onQualityCeiling,
  children,
}: EngineCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [value, setValue] = React.useState<EngineContextValue>({
    engine: null,
    canvas: null,
  })
  const [error, setError] = React.useState<string | null>(null)
  // Auto with a cached probe result starts at once, without the "Choosing quality…" pass.
  const [probing, setProbing] = React.useState(
    () => quality === undefined && cachedQuality() === null
  )
  const onEngineRef = React.useRef(onEngine)
  const onCeilingRef = React.useRef(onQualityCeiling)
  const initialQuality = React.useRef(quality)
  // Token models come from the free asset catalog (none without services, e.g. in tests).
  const services = React.useContext(ServicesContext)
  const tokenModels = React.useRef<TokenModelSource | undefined>(
    services
      ? { resolveUrl: (ref) => services.freeAssets.tokenModelUrl(ref) }
      : undefined
  )

  React.useEffect(() => {
    onEngineRef.current = onEngine
    onCeilingRef.current = onQualityCeiling
  }, [onEngine, onQualityCeiling])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let created: Engine | null = null

    const start = (q: Quality) => {
      if (cancelled) return
      let engine: Engine
      try {
        engine = createEngine(canvas, {
          quality: q,
          tokenModels: tokenModels.current,
        })
      } catch (err) {
        queueMicrotask(() =>
          setError(err instanceof Error ? err.message : String(err))
        )
        return
      }
      created = engine
      queueMicrotask(() => {
        if (cancelled) return
        setValue({ engine, canvas })
        onEngineRef.current?.(engine)
        onCeilingRef.current?.(q)
      })
    }

    const explicit = initialQuality.current
    const cached = explicit
      ? null
      : cachedQuality({
          cssWidth: canvas.clientWidth || undefined,
          cssHeight: canvas.clientHeight || undefined,
        })
    if (explicit) {
      start(explicit)
    } else if (cached) {
      queueMicrotask(() => setProbing(false))
      start(cached.tier)
    } else {
      void probeInitialQuality(
        canvas.clientWidth || undefined,
        canvas.clientHeight || undefined
      ).then((q) => {
        if (cancelled) return
        setProbing(false)
        start(q)
      })
    }
    return () => {
      cancelled = true
      if (created) {
        onEngineRef.current?.(null)
        created.dispose()
        created = null
      }
    }
  }, [])

  React.useEffect(() => {
    if (!value.engine || !quality) return
    value.engine.setQuality(quality)
    onCeilingRef.current?.(quality)
  }, [value.engine, quality])

  return (
    <EngineContext.Provider value={value}>
      <div
        className={cn("relative size-full overflow-hidden bg-black", className)}
      >
        <canvas
          ref={canvasRef}
          data-slot="engine-canvas"
          className="block size-full touch-none outline-none"
          tabIndex={0}
        />
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            WebGL2 is required to render maps. {error}
          </div>
        ) : probing ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground"
          >
            Choosing quality…
          </div>
        ) : null}
        {children}
      </div>
    </EngineContext.Provider>
  )
}
