/**
 * The selected layer's settings (image, placement, opacity), its mask (disc, pop-out, painted edits),
 * the token disc, and background removal.
 */
import * as React from "react"
import { Crosshair, Eraser, FlipHorizontal2, Maximize, Minimize, Move, Paintbrush, RotateCcw, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { ColorInput, FieldRow, Hint, PanelSection, Segmented, SliderInput, SwitchField, TextInput } from "@/components/editor/fields"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { clearStrokes, findLayer, setMask, setTransform, TOKEN_LIMITS, updateLayer } from "@/core/tokenMaker/design"
import { describeImageToolError } from "@/net/imageTools"
import { fitDiscToFrame, frameLayer, removeLayerBackground } from "@/tokenMaker/actions"
import type { MakerTool } from "@/tokenMaker/store"

import { useMaker, useTokenMaker } from "./context"

const pct = (v: number) => `${Math.round(v * 100)}%`

const TOOL_OPTIONS: ReadonlyArray<{ value: MakerTool; label: string; icon: React.ReactNode; tooltip: string }> = [
  { value: "move", label: "Move", icon: <Move />, tooltip: "Move, scale and rotate the selected layer (V)" },
  { value: "reveal", label: "Reveal", icon: <Paintbrush />, tooltip: "Paint the selected layer back in, e.g. a hand breaking out of the frame (B)" },
  { value: "hide", label: "Hide", icon: <Eraser />, tooltip: "Paint the selected layer away (E)" },
]

/** Mask brush controls (shared by the stage toolbar and the mask section). */
export function BrushControls() {
  const { store } = useTokenMaker()
  const tool = useMaker((s) => s.tool)
  const brush = useMaker((s) => s.brush)
  return (
    <>
      <Segmented aria-label="Tool" value={tool} onValueChange={(t) => store.getState().setTool(t)} options={TOOL_OPTIONS} />
      {tool !== "move" ? (
        <SliderInput
          aria-label="Brush size"
          className="min-w-32"
          value={brush}
          min={TOKEN_LIMITS.minBrush}
          max={0.25}
          step={0.005}
          format={pct}
          onChange={(v) => store.getState().setBrush(v)}
        />
      ) : null}
    </>
  )
}

export function LayerInspector() {
  const { store } = useTokenMaker()
  const services = useServices()
  const design = useMaker((s) => s.design)
  const selectedId = useMaker((s) => s.selectedId)
  const busy = useMaker((s) => (s.selectedId ? s.working[s.selectedId] : undefined))
  const abort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => abort.current?.abort(), [])

  const layer = findLayer(design, selectedId)
  if (!layer) {
    return (
      <PanelSection title="Layer">
        <Hint>Select a layer in the list or click it on the canvas.</Hint>
      </PanelSection>
    )
  }
  const commit = (next: typeof design, coalesce?: string) => store.getState().commit(next, coalesce)
  const t = layer.transform
  const image = layer.source.type === "image" ? layer.source : null

  const removeBackground = async () => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    try {
      await removeLayerBackground(store, services.backgroundRemover, layer.id, ctrl.signal)
      toast.success("Background removed", {
        description: layer.mask.shape === "disc" ? "It can break out of the frame now: paint with Hide to trim it." : undefined,
        action: { label: "Undo", onClick: () => store.getState().undo() },
      })
    } catch (err) {
      if (ctrl.signal.aborted) return
      toast.error("Couldn't remove the background", { description: describeImageToolError(err) })
    }
  }

  /** Contain the image in the canvas (fit) or cover the canvas with it (fill), centred. */
  const refit = (mode: "fit" | "fill") => {
    if (!image) return
    const aspect = image.width / image.height
    const scale = mode === "fit" ? Math.min(1, aspect) : Math.max(1, aspect)
    commit(setTransform(design, layer.id, { ...t, x: 0.5, y: 0.5, scale }))
  }

  return (
    <>
      <PanelSection title="Layer">
        <FieldRow label="Name">
          <TextInput value={layer.name} maxLength={TOKEN_LIMITS.maxName} onCommit={(name) => commit(updateLayer(design, layer.id, (l) => ({ ...l, name })))} />
        </FieldRow>
        {image ? (
          <>
            <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2 ring-1 ring-border/60">
              <Button size="sm" variant="secondary" disabled={!services.backgroundRemover.available || !!busy} onClick={() => void removeBackground()}>
                {busy ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
                {busy ? "Removing the background…" : "Remove background"}
              </Button>
              {busy ? (
                <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                  Cancel
                </Button>
              ) : null}
              <Hint>
                {services.backgroundRemover.available
                  ? "An image model cuts the character out (it takes a little while). Undo brings the original back."
                  : "Background removal needs Atlas Cloud or the dev server with an image model key."}
              </Hint>
            </div>
            <FieldRow label="Size">
              <SliderInput
                value={t.scale}
                min={0.05}
                max={3}
                step={0.01}
                format={pct}
                onChange={(scale) => commit(setTransform(design, layer.id, { ...t, scale }), `scale:${layer.id}`)}
              />
            </FieldRow>
            <FieldRow label="Rotation">
              <SliderInput
                value={t.rotation}
                min={-180}
                max={180}
                step={1}
                format={(v) => `${Math.round(v)}°`}
                onChange={(rotation) => commit(setTransform(design, layer.id, { ...t, rotation }), `rotate:${layer.id}`)}
              />
            </FieldRow>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" onClick={() => commit(setTransform(design, layer.id, { ...t, flipX: !t.flipX }))}>
                <FlipHorizontal2 data-icon="inline-start" /> Flip
              </Button>
              <Button size="sm" variant="outline" onClick={() => commit(setTransform(design, layer.id, { ...t, x: 0.5, y: 0.5 }))}>
                <Crosshair data-icon="inline-start" /> Centre
              </Button>
              <Button size="sm" variant="outline" onClick={() => refit("fit")}>
                <Minimize data-icon="inline-start" /> Fit
              </Button>
              <Button size="sm" variant="outline" onClick={() => refit("fill")}>
                <Maximize data-icon="inline-start" /> Fill
              </Button>
            </div>
          </>
        ) : layer.source.type === "fill" ? (
          <FieldRow label="Colour">
            <ColorInput
              value={layer.source.color}
              onChange={(color) =>
                commit(
                  updateLayer(design, layer.id, (l) => ({ ...l, source: { type: "fill", color } })),
                  `color:${layer.id}`
                )
              }
            />
          </FieldRow>
        ) : null}
        <FieldRow label="Opacity">
          <SliderInput
            value={layer.opacity}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(opacity) =>
              commit(
                updateLayer(design, layer.id, (l) => ({ ...l, opacity })),
                `opacity:${layer.id}`
              )
            }
          />
        </FieldRow>
      </PanelSection>

      <PanelSection title="Mask">
        <FieldRow label="Shape" hint="Where the layer shows before any painting">
          <Segmented
            value={layer.mask.shape}
            onValueChange={(shape) => commit(setMask(design, layer.id, { shape }))}
            options={[
              { value: "disc", label: "Token disc" },
              { value: "none", label: "Whole canvas" },
            ]}
          />
        </FieldRow>
        {layer.mask.shape === "disc" ? (
          <>
            <SwitchField
              label="Break out of the frame"
              description="Everything above the disc's centre shows too, drawn over the frame. Paint with Hide or Reveal to fine-tune."
              checked={layer.mask.popOut}
              onCheckedChange={(popOut) => commit(setMask(design, layer.id, { popOut }))}
            />
            <FieldRow label="Disc size" hint="Grow or shrink the disc for this layer only (e.g. a backdrop reaching under the ring)">
              <SliderInput
                value={layer.mask.grow}
                min={-0.1}
                max={0.1}
                step={0.002}
                format={(v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}`}
                onChange={(grow) => commit(setMask(design, layer.id, { grow }), `grow:${layer.id}`)}
              />
            </FieldRow>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <BrushControls />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Hint>
            {layer.mask.strokes.length
              ? `${layer.mask.strokes.length} painted stroke${layer.mask.strokes.length === 1 ? "" : "s"}.`
              : "Reveal paints parts back in, in front of the frame (a hand, a weapon); Hide paints them away."}
          </Hint>
          {layer.mask.strokes.length ? (
            <Button size="sm" variant="ghost" onClick={() => commit(clearStrokes(design, layer.id))}>
              <Trash2 data-icon="inline-start" /> Clear
            </Button>
          ) : null}
        </div>
      </PanelSection>
    </>
  )
}

export function DiscSection() {
  const { store, cache } = useTokenMaker()
  const radius = useMaker((s) => s.design.radius)
  const frame = useMaker((s) => frameLayer(s.design))
  const [fitting, setFitting] = React.useState(false)
  const fit = async () => {
    if (!frame) return
    setFitting(true)
    try {
      const r = await fitDiscToFrame(store, cache, frame.id)
      if (r === null) toast.info("Couldn't find the frame's opening", { description: "Centre the frame, or set the disc size by hand." })
    } finally {
      setFitting(false)
    }
  }
  return (
    <PanelSection title="Token disc">
      <FieldRow label="Radius" hint="The round window every disc mask uses: match it to the frame's opening">
        <SliderInput
          value={radius}
          min={TOKEN_LIMITS.minRadius}
          max={TOKEN_LIMITS.maxRadius}
          step={0.002}
          format={(v) => pct(v * 2)}
          onChange={(r) => store.getState().setRadius(r, "radius")}
        />
      </FieldRow>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={!frame || fitting} onClick={() => void fit()}>
          {fitting ? <Spinner data-icon="inline-start" /> : <Crosshair data-icon="inline-start" />} Fit to frame
        </Button>
        <Button size="sm" variant="ghost" onClick={() => store.getState().setRadius(0.42)}>
          <RotateCcw data-icon="inline-start" /> Reset
        </Button>
      </div>
    </PanelSection>
  )
}
