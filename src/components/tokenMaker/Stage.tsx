/**
 * The Token Maker's stage: a clipped viewport showing the live composite on a transparency
 * checkerboard, with the selected layer's outline (also where it reaches past the token), the token
 * disc and the mask brush drawn over it, the floating toolbar above and zoom controls below.
 *
 * Move tool: click picks the topmost layer that is opaque under the pointer (so the frame's hole lets
 * clicks through to the character), drag moves the selected layer, wheel scales it about the pointer,
 * Shift+wheel rotates it. Reveal / Hide paint the selected layer's mask (wheel sizes the brush); while
 * painting, the layer's hidden parts show as a faint ghost. The view: Ctrl/⌘+wheel (or a pinch) zooms
 * about the pointer, Space+drag or a middle-button drag pans (tokenMaker/view.ts).
 */
import * as React from "react"
import { ImagePlus, Minus, Plus, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  addStroke,
  CENTRE,
  extendStroke,
  findLayer,
  layerCorners,
  layerDisc,
  pickLayer,
  popOutRect,
  setTransform,
  translateLayer,
  zoomLayerAt,
} from "@/core/tokenMaker/design"
import type { CanvasPoint, MaskStroke } from "@/core/tokenMaker/types"
import { isTextEntry } from "@/lib/hotkeys"
import { cn } from "@/lib/utils"
import { renderDesign } from "@/tokenMaker/render"
import { DEFAULT_VIEW, panView, screenToCanvas, tokenRect, zoomViewAt, zoomViewCentre, ZOOM_STEP, type Viewport } from "@/tokenMaker/view"

import { useMaker, useTokenMaker } from "./context"
import { floating, StageToolbar } from "./StageToolbar"

type Drag =
  | { kind: "move"; id: string; last: CanvasPoint; key: string }
  | { kind: "paint"; id: string; stroke: MaskStroke }
  | { kind: "pan"; lastX: number; lastY: number }

/** Largest composite rendered per frame (zoomed further, the canvas is scaled up). */
const MAX_RENDER_PX = 2048

const isControl = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest("button, a, [role='button'], [role='slider'], [role='menuitem'], [role='checkbox'], [role='switch'], [role='tab']")

export function Stage({ className }: { className?: string }) {
  const { store, cache, pickFile } = useTokenMaker()
  const design = useMaker((s) => s.design)
  const selectedId = useMaker((s) => s.selectedId)
  const tool = useMaker((s) => s.tool)
  const brush = useMaker((s) => s.brush)
  const decodedRev = useMaker((s) => s.decodedRev)
  const working = useMaker((s) => s.working)
  const view = useMaker((s) => s.view)

  const viewportRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = React.useState<Viewport>({ width: 0, height: 0 })
  const [pending, setPending] = React.useState<{ layerId: string; stroke: MaskStroke } | null>(null)
  const [cursor, setCursor] = React.useState<CanvasPoint | null>(null)
  const [spaceHeld, setSpaceHeld] = React.useState(false)
  const [panning, setPanning] = React.useState(false)
  const drag = React.useRef<Drag | null>(null)

  React.useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setVp({ width: Math.floor(r.width), height: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Space held: the pointer pans (not while a control has focus: Space presses it).
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTextEntry(e.target) || isControl(e.target)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", blur)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", blur)
    }
  }, [])

  // Zoom keys: = / + in, - out, 0 fits.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return
      const s = store.getState()
      if (e.key === "=" || e.key === "+") s.setView(zoomViewCentre(s.view, vp, ZOOM_STEP))
      else if (e.key === "-" || e.key === "_") s.setView(zoomViewCentre(s.view, vp, 1 / ZOOM_STEP))
      else if (e.key === "0") s.setView(DEFAULT_VIEW)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store, vp])

  const selected = findLayer(design, selectedId)
  const painting = tool !== "move"
  const rect = tokenRect(view, vp)
  const ready = vp.width > 0 && vp.height > 0

  // Draw the composite at the token's on-screen size (capped).
  React.useEffect(() => {
    const c = canvasRef.current
    if (!c || !ready) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const px = Math.max(1, Math.min(MAX_RENDER_PX, Math.round(rect.side * dpr)))
    if (c.width !== px || c.height !== px) {
      c.width = px
      c.height = px
    }
    const ctx = c.getContext("2d")
    if (!ctx) return
    const lookup = (id: string) => cache.get(id)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, px, px)
    if (painting && selected) renderDesign(ctx, design, lookup, px, { solo: selected.id, alpha: 0.28 })
    renderDesign(ctx, design, lookup, px, { pending })
  }, [cache, design, decodedRev, pending, rect.side, ready, selected, painting])

  const local = (e: { clientX: number; clientY: number }) => {
    const r = viewportRef.current!.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }
  const toCanvas = (e: { clientX: number; clientY: number }): CanvasPoint => {
    const { sx, sy } = local(e)
    return screenToCanvas(store.getState().view, vp, sx, sy)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { kind: "pan", lastX: e.clientX, lastY: e.clientY }
      setPanning(true)
      return
    }
    if (e.button !== 0) return
    const p = toCanvas(e)
    const s = store.getState()
    if (s.tool === "move") {
      const picked = pickLayer(s.design, p, (l, u, v) => l.source.type === "image" && cache.alphaAt(l.source.imageId, u, v) > 0.1)
      let id = s.selectedId
      if (picked && picked.id !== id) {
        id = picked.id
        s.select(id)
      }
      if (!id) return
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { kind: "move", id, last: p, key: `move:${id}:${e.timeStamp}` }
      return
    }
    const layer = findLayer(s.design, s.selectedId)
    if (!layer) {
      toast.info("Pick a layer first", { id: "paint-no-layer", description: "The brush paints the selected layer's mask." })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const stroke: MaskStroke = { mode: s.tool === "reveal" ? "reveal" : "hide", size: s.brush, points: extendStroke([], p, s.brush) }
    drag.current = { kind: "paint", id: layer.id, stroke }
    setPending({ layerId: layer.id, stroke })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d?.kind === "pan") {
      const s = store.getState()
      s.setView(panView(s.view, vp, e.clientX - d.lastX, e.clientY - d.lastY))
      d.lastX = e.clientX
      d.lastY = e.clientY
      return
    }
    const p = toCanvas(e)
    setCursor(p)
    if (!d) return
    if (d.kind === "move") {
      const s = store.getState()
      const l = findLayer(s.design, d.id)
      if (!l) return
      s.commit(setTransform(s.design, d.id, translateLayer(l.transform, p.x - d.last.x, p.y - d.last.y)), d.key)
      d.last = p
    } else {
      const points = extendStroke(d.stroke.points, p, d.stroke.size)
      if (points !== d.stroke.points) {
        d.stroke = { ...d.stroke, points }
        setPending({ layerId: d.id, stroke: d.stroke })
      }
    }
  }

  const endDrag = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === "pan") setPanning(false)
    if (d?.kind === "paint") {
      const s = store.getState()
      const next = addStroke(s.design, d.id, d.stroke)
      if (next === s.design) toast.warning("This layer's mask is full", { id: "mask-full", description: "Clear its painting to start over." })
      s.commit(next)
      setPending(null)
    }
  }

  // Wheel (non-passive, to keep the page still): Ctrl/⌘ (and pinches) zoom the view; otherwise scale /
  // rotate the selected layer, or size the brush.
  React.useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const s = store.getState()
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      const delta = e.deltaY || e.deltaX
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        s.setView(zoomViewAt(s.view, vp, sx, sy, Math.exp(-delta * 0.002)))
        return
      }
      if (s.tool !== "move") {
        e.preventDefault()
        s.setBrush(s.brush * Math.exp(-delta * 0.002))
        return
      }
      const l = findLayer(s.design, s.selectedId)
      if (!l || l.source.type !== "image") return
      e.preventDefault()
      const t =
        e.shiftKey || e.altKey
          ? { ...l.transform, rotation: l.transform.rotation + Math.sign(delta) * 2 }
          : zoomLayerAt(l.transform, screenToCanvas(s.view, vp, sx, sy), Math.exp(-delta * 0.0015))
      s.commit(setTransform(s.design, l.id, t), `wheel:${l.id}`)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [store, vp])

  const hasSubject = design.layers.some((l, i) => i > 0 && l.mask.shape === "disc")
  const workingLabel = Object.values(working)[0] ?? null
  const disc = selected ? layerDisc(design, selected) : { cx: CENTRE.x, cy: CENTRE.y, r: design.radius }
  const pop = selected ? popOutRect(design, selected) : null
  const showDisc = painting || selected?.mask.shape === "disc"
  const zoomBy = (factor: number) => {
    const s = store.getState()
    s.setView(zoomViewCentre(s.view, vp, factor))
  }
  const cursorClass = panning ? "cursor-grabbing" : spaceHeld ? "cursor-grab" : painting ? "cursor-none" : "cursor-grab active:cursor-grabbing"

  return (
    <div
      ref={viewportRef}
      className={cn("relative min-h-0 min-w-0 touch-none overflow-hidden rounded-xl border bg-muted/30 select-none", cursorClass, className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setCursor(null)}
      onAuxClick={(e) => e.preventDefault()}
    >
      {ready ? (
        <>
          <canvas
            ref={canvasRef}
            aria-label="Token preview. Drag to move the selected layer, scroll to resize it, Shift+scroll to rotate it, Ctrl+scroll to zoom."
            className="absolute atlas-checkerboard ring-1 ring-border"
            style={{ left: rect.left, top: rect.top, width: rect.side, height: rect.side }}
          />
          <svg aria-hidden className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${vp.width} ${vp.height}`}>
            <g transform={`translate(${rect.left} ${rect.top}) scale(${rect.side})`}>
              {showDisc ? (
                <circle
                  cx={disc.cx}
                  cy={disc.cy}
                  r={disc.r}
                  fill="none"
                  className="stroke-foreground/45"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {pop ? (
                <rect
                  x={pop.x}
                  y={pop.y}
                  width={pop.w}
                  height={pop.h}
                  fill="none"
                  className="stroke-foreground/25"
                  strokeWidth={1}
                  strokeDasharray="2 5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {selected && selected.source.type === "image" && !painting ? (
                <polygon
                  points={layerCorners(selected)
                    .map((c) => `${c.x},${c.y}`)
                    .join(" ")}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {painting && cursor && !spaceHeld ? (
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={brush / 2}
                  fill="none"
                  className="stroke-foreground"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          </svg>
        </>
      ) : null}

      {/* Floating toolbar above the token, zoom controls below. */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center" onPointerDown={(e) => e.stopPropagation()}>
        <StageToolbar />
      </div>
      <div
        className={cn("pointer-events-auto absolute right-2 bottom-2 flex items-center gap-0.5 p-1", floating)}
        role="group"
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)} />}>
            <Minus />
          </TooltipTrigger>
          <TooltipContent>
            Zoom out <Kbd>-</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="w-12 tabular-nums"
                aria-label="Fit the token"
                onClick={() => store.getState().setView(DEFAULT_VIEW)}
              />
            }
          >
            {Math.round(view.zoom * 100)}%
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            Fit the token <Kbd>0</Kbd>. Ctrl + scroll zooms about the pointer; Space + drag pans.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)} />}>
            <Plus />
          </TooltipTrigger>
          <TooltipContent>
            Zoom in <Kbd>=</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      {design.layers.length === 0 ? (
        <Empty className="absolute inset-0" onPointerDown={(e) => e.stopPropagation()}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImagePlus />
            </EmptyMedia>
            <EmptyTitle>Start your token</EmptyTitle>
            <EmptyDescription>Add character art, a background and a frame, then mask them into a token.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => pickFile("subject")}>
              <ImagePlus data-icon="inline-start" /> Add character art
            </Button>
          </EmptyContent>
        </Empty>
      ) : !hasSubject ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 flex justify-center">
          <Button size="lg" className="pointer-events-auto shadow-lg" onPointerDown={(e) => e.stopPropagation()} onClick={() => pickFile("subject")}>
            <ImagePlus data-icon="inline-start" /> Add character art
          </Button>
        </div>
      ) : null}

      {workingLabel ? (
        <div className="absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-[2px]" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs shadow-md ring-1 ring-border">
            <Spinner />
            <Sparkles className="size-3.5 text-primary" />
            {workingLabel}
          </div>
        </div>
      ) : null}
    </div>
  )
}
