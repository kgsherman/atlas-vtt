/**
 * Loading card over the engine canvas: the device probe (no engine yet), then the engine's load state
 * (shader compilation, first shadow captures; Engine.getLoadState). Non-blocking: the page stays usable
 * underneath (pointer events pass through), and it fades in after a short delay so fast loads never flash.
 */
import * as React from "react"

import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { Engine, EngineLoadState } from "@/render"

const STAGE_LABEL: Record<EngineLoadState["stage"], string> = {
  compiling: "Preparing shaders",
  lighting: "Lighting the scene",
  ready: "Ready",
}

const NOT_LOADING = () => null

function useLoadState(engine: Engine | null): EngineLoadState | null {
  const subscribe = React.useCallback((onChange: () => void) => engine?.onLoadState(onChange) ?? (() => {}), [engine])
  const get = React.useCallback(() => engine?.getLoadState() ?? null, [engine])
  return React.useSyncExternalStore(subscribe, engine ? get : NOT_LOADING)
}

export function EngineLoading({
  engine,
  probing,
}: {
  engine: Engine | null
  /** The device probe runs (no engine yet). */
  probing: boolean
}) {
  const state = useLoadState(engine)
  if (!probing && !state?.loading) return null
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="w-64 animate-in rounded-lg border bg-card/90 px-4 py-3 shadow-lg backdrop-blur-sm delay-150 duration-300 fade-in-0 fill-mode-both zoom-in-95">
        {probing || !state ? (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Choosing quality…
          </div>
        ) : (
          <Progress value={Math.round(state.progress * 100)} aria-label="Loading the map">
            <ProgressLabel className="text-muted-foreground">{STAGE_LABEL[state.stage]}…</ProgressLabel>
            <ProgressValue />
          </Progress>
        )}
      </div>
    </div>
  )
}
