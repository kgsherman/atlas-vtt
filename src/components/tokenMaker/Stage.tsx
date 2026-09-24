/**
 * The Token Maker's canvas: the live composite on a transparency checkerboard, with the selected
 * layer's outline, the token disc and the mask brush drawn over it.
 *
 * Move tool: click picks the topmost layer that is opaque under the pointer (so the frame's hole lets
 * clicks through to the character), drag moves the selected layer, wheel scales it about the pointer,
 * Shift+wheel rotates it. Reveal / Hide tools paint the selected layer's mask (wheel sizes the brush);
 * while painting, the layer's hidden parts show as a faint ghost.
 */
import * as React from "react"
import { ImagePlus, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
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
import { cn } from "@/lib/utils"
import { renderDesign } from "@/tokenMaker/render"

import { useMaker, useTokenMaker } from "./context"

type Drag = { kind: "move"; id: string; last: CanvasPoint; key: string } | { kind: "paint"; id: string; stroke: MaskStroke }

const MAX_STAGE = 720

/** A pointer position in canvas units. */
function pointOn(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): CanvasPoint {
  const r = canvas.getBoundingClientRect()
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
}

export function Stage({ className }: { className?: string }) {
  const { store, cache, pickFile } = useTokenMaker()
  const design = useMaker((s) => s.design)
  const selectedId = useMaker((s) => s.selectedId)
  const tool = useMaker((s) => s.tool)
  const brush = useMaker((s) => s.brush)
  const decodedRev = useMaker((s) => s.decodedRev)
  const working = useMaker((s) => s.working)

  const wrapRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [size, setSize] = React.useState(0)
  const [pending, setPending] = React.useState<{ layerId: string; stroke: MaskStroke } | null>(null)
  const [cursor, setCursor] = React.useState<CanvasPoint | null>(null)
  const drag = React.useRef<Drag | null>(null)

  // Square stage that fits its box.
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize(Math.max(0, Math.floor(Math.min(r.width, r.height, MAX_STAGE))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const selected = findLayer(design, selectedId)
  const painting = tool !== "move"

  // Draw.
  React.useEffect(() => {
    const c = canvasRef.current
    if (!c || size <= 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const px = Math.round(size * dpr)
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
  }, [cache, design, decodedRev, pending, size, selected, painting])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const p = pointOn(e.currentTarget, e)
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

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointOn(e.currentTarget, e)
    setCursor(p)
    const d = drag.current
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
    if (d?.kind === "paint") {
      const s = store.getState()
      const next = addStroke(s.design, d.id, d.stroke)
      if (next === s.design) toast.warning("This layer's mask is full", { id: "mask-full", description: "Clear its painting to start over." })
      s.commit(next)
      setPending(null)
    }
  }

  // Wheel: scale / rotate the selected layer, or size the brush (non-passive, to keep the page still).
  React.useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      const s = store.getState()
      const delta = e.deltaY || e.deltaX
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
          : zoomLayerAt(l.transform, pointOn(c, e), Math.exp(-delta * 0.0015))
      s.commit(setTransform(s.design, l.id, t), `wheel:${l.id}`)
    }
    c.addEventListener("wheel", onWheel, { passive: false })
    return () => c.removeEventListener("wheel", onWheel)
  }, [store, size])

  const hasSubject = design.layers.some((l, i) => i > 0 && l.mask.shape === "disc")
  const workingLabel = Object.values(working)[0] ?? null
  const disc = selected ? layerDisc(design, selected) : { cx: CENTRE.x, cy: CENTRE.y, r: design.radius }
  const pop = selected ? popOutRect(design, selected) : null
  const showDisc = painting || selected?.mask.shape === "disc"

  return (
    <div ref={wrapRef} className={cn("relative grid min-h-0 min-w-0 place-items-center", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          aria-label="Token preview. Drag to move the selected layer, scroll to resize it, Shift+scroll to rotate it."
          className={cn(
            "absolute inset-0 size-full touch-none rounded-xl atlas-checkerboard ring-1 ring-border",
            painting ? "cursor-none" : "cursor-grab active:cursor-grabbing"
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setCursor(null)}
        />
        <svg aria-hidden viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible">
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
          {painting && cursor ? (
            <circle cx={cursor.x} cy={cursor.y} r={brush / 2} fill="none" className="stroke-foreground" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>

        {design.layers.length === 0 ? (
          <Empty className="absolute inset-0 rounded-xl">
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
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
            <Button size="lg" className="shadow-lg" onClick={() => pickFile("subject")}>
              <ImagePlus data-icon="inline-start" /> Add character art
            </Button>
          </div>
        ) : null}

        {workingLabel ? (
          <div className="absolute inset-0 grid place-items-center rounded-xl bg-background/60 backdrop-blur-[2px]">
            <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs shadow-md ring-1 ring-border">
              <Spinner />
              <Sparkles className="size-3.5 text-primary" />
              {workingLabel}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
