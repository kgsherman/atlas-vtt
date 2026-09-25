/**
 * Areas of effect on the map (ARCHITECTURE §6.6), for the player view and the DM's live view: computes
 * what each template reaches in the scene this page has (play/templateAreas, tested against the page's
 * occlusion world), pushes the engine overlays (filled squares, outline, origin) and places HTML over
 * them every frame (no React render per frame):
 *  - a chip at each template's point of origin (its title and how many creatures it catches) that
 *    selects it; carried templates follow their token as it walks;
 *  - rings around the creatures the selected template (or the one being placed) catches.
 * Under the HUD panels (z-5) like the turn marker.
 */
import * as React from "react"

import { useEngine } from "@/components/canvas/engineContext"
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import type { OcclusionWorld } from "@/core/occlusion/types"
import type { Id, SceneLike, Vec3 } from "@/core/scene/types"
import { cn } from "@/lib/utils"
import {
  groundY,
  TemplateAreas,
  templateTitle,
  type PlayController,
  type TemplateItem,
  type TemplateView,
} from "@/play"

import { CHIP_GAP, stackChip, type ChipRect } from "./templateChips"

export interface TemplateLayerProps {
  controller: PlayController
  scene: SceneLike | null
  items: readonly TemplateItem[]
  /** The occlusion world of `scene` (null: not ready). Read after layout effects. */
  world(): OcclusionWorld | null
  selectedId: Id | null
  onSelect(id: Id | null): void
  /** The selected template with what it reaches (null: none or gone). */
  onSelectedView(view: TemplateView | null): void
  /** Whether a level's contents are shown (cutaway). */
  showOn(levelId: Id): boolean
  /** false: draw nothing (the DM's map screen in Edit). */
  enabled?: boolean
}

const noDraft = () => null

export function TemplateLayer({
  controller,
  scene,
  items,
  world,
  selectedId,
  onSelect,
  onSelectedView,
  showOn,
  enabled = true,
}: TemplateLayerProps) {
  const { engine, canvas } = useEngine()
  const draft = React.useSyncExternalStore(
    controller.subscribe,
    enabled ? () => controller.templateDraft() : noDraft
  )
  const spec = React.useSyncExternalStore(controller.subscribe, () =>
    controller.getTemplateSpec()
  )
  const [areas] = React.useState(() => new TemplateAreas())
  const [views, setViews] = React.useState<TemplateView[]>([])
  const worldRef = React.useRef(world)
  const selectedRef = React.useRef<{
    onSelectedView: TemplateLayerProps["onSelectedView"]
  }>({ onSelectedView })
  React.useEffect(() => {
    worldRef.current = world
    selectedRef.current.onSelectedView = onSelectedView
  })

  // After layout effects: the page's planner / runner world matches `scene` by then. A draft that follows
  // the pointer is computed once per frame at most (the latest one wins).
  React.useEffect(() => {
    const run = () => {
      const w = worldRef.current()
      if (!enabled || !scene || !w) {
        setViews([])
        return
      }
      setViews(areas.compute(scene, w, items, draft ? { draft, spec } : null))
    }
    if (!draft) {
      run()
      return
    }
    const frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }, [areas, enabled, scene, items, draft, spec])

  React.useEffect(() => {
    engine?.setOverlays({
      templates: enabled ? areas.overlaysOf(views, selectedId) : [],
    })
  }, [engine, areas, views, selectedId, enabled])
  React.useEffect(() => () => engine?.setOverlays({ templates: [] }), [engine])

  const selected = React.useMemo(
    () => views.find((v) => v.id === selectedId && !v.draft) ?? null,
    [views, selectedId]
  )
  React.useEffect(() => {
    selectedRef.current.onSelectedView(selected)
  }, [selected])
  // A selected template that is gone (removed, out of view) is no longer selected.
  React.useEffect(() => {
    if (selectedId && !items.some((i) => i.id === selectedId)) onSelect(null)
  }, [items, selectedId, onSelect])

  const draftView = views.find((v) => v.draft) ?? null
  const ringed = draftView ?? selected

  // ---- per-frame placement ---------------------------------------------------------------------------
  const chips = React.useRef(new Map<Id, HTMLElement>())
  const rings = React.useRef(new Map<Id, HTMLElement>())
  const showRef = React.useRef(showOn)
  React.useEffect(() => {
    showRef.current = showOn
  })
  React.useEffect(() => {
    if (!engine || !canvas || !scene) return
    const anchors = new Map<Id, { view: TemplateView; at: Vec3 }>()
    for (const v of views) {
      const g = v.geometry
      anchors.set(v.id, {
        view: v,
        at: { x: g.x, y: groundY(scene, g.levelId, g), z: g.z },
      })
    }
    const place = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Chips: projected, measured, then stacked upwards where they would overlap (lowest first). All
      // reads come before the writes (no forced style recalculation per chip).
      const hidden: HTMLElement[] = []
      const shown: {
        el: HTMLElement
        x: number
        y: number
        w: number
        h: number
      }[] = []
      for (const [id, el] of chips.current) {
        const a = anchors.get(id)
        if (!a) continue
        const carrier = a.view.source.tokenId
        const drawn = carrier ? engine.tokenDrawnAt(carrier) : null
        const levelId = drawn?.levelId ?? a.view.geometry.levelId
        const s = engine.project(drawn?.position ?? a.at)
        const inside = s.visible && s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h
        if (!inside || !showRef.current(levelId)) {
          hidden.push(el)
          continue
        }
        const chip = el.firstElementChild as HTMLElement | null
        shown.push({
          el,
          x: Math.round(s.x),
          y: Math.round(s.y),
          w: chip?.offsetWidth ?? 0,
          h: chip?.offsetHeight ?? 0,
        })
      }
      shown.sort((a, b) => b.y - a.y)
      const placed: ChipRect[] = []
      for (const c of shown) {
        const r = stackChip(placed, {
          x: c.x - c.w / 2,
          y: c.y - CHIP_GAP - c.h,
          w: c.w,
          h: c.h,
        })
        placed.push(r)
        c.el.style.transform = `translate(${c.x}px, ${Math.round(r.y + c.h + CHIP_GAP)}px)`
        c.el.style.visibility = "visible"
      }
      for (const el of hidden) el.style.visibility = "hidden"
      for (const [id, el] of rings.current) {
        const at = engine.tokenDrawnAt(id)
        const t = Object.hasOwn(scene.tokens, id) ? scene.tokens[id] : null
        if (!at || !t || !showRef.current(at.levelId)) {
          el.style.visibility = "hidden"
          continue
        }
        const radius = (SIZE_FOOTPRINT[t.size] * scene.grid.cellSize) / 2
        const c = engine.project(at.position)
        const e = engine.project({
          x: at.position.x + radius,
          y: at.position.y,
          z: at.position.z,
        })
        if (!c.visible) {
          el.style.visibility = "hidden"
          continue
        }
        const r = Math.max(12, Math.hypot(e.x - c.x, e.y - c.y) + 3)
        el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`
        el.style.setProperty("--area-r", `${r}px`)
        el.style.visibility = "visible"
      }
    }
    place()
    return engine.onFrame(place)
  }, [engine, canvas, scene, views, ringed])

  if (!enabled) return null
  return (
    <>
      {ringed
        ? ringed.tokenIds.map((id) => (
            <div
              key={`${ringed.id}:${id}`}
              ref={(el) => {
                if (el) rings.current.set(id, el)
                else rings.current.delete(id)
              }}
              className="pointer-events-none absolute top-0 left-0 z-[5]"
              style={{ visibility: "hidden" }}
              data-slot="area-target"
            >
              <span
                className="absolute rounded-full border-2 shadow-[0_0_8px_rgba(0,0,0,0.6)]"
                style={{
                  borderColor: ringed.color,
                  top: "calc(var(--area-r) * -1)",
                  left: "calc(var(--area-r) * -1)",
                  width: "calc(var(--area-r) * 2)",
                  height: "calc(var(--area-r) * 2)",
                }}
              />
            </div>
          ))
        : null}
      {views.map((v) => (
        <div
          key={v.id}
          ref={(el) => {
            if (el) chips.current.set(v.id, el)
            else chips.current.delete(v.id)
          }}
          className="pointer-events-none absolute top-0 left-0 z-[5]"
          style={{ visibility: "hidden" }}
          data-slot="area-chip"
          data-template-id={v.id}
        >
          <button
            type="button"
            disabled={v.draft}
            onClick={() => onSelect(v.id === selectedId ? null : v.id)}
            className={cn(
              "absolute left-0 flex -translate-x-1/2 -translate-y-[calc(100%+10px)] items-center gap-1.5 rounded-full border bg-card/85 px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap text-foreground shadow-md backdrop-blur-sm",
              v.draft
                ? "opacity-90"
                : "pointer-events-auto cursor-pointer hover:bg-card",
              v.id === selectedId && "ring-2 ring-primary"
            )}
            title={v.draft ? undefined : "Show this area's details"}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: v.color }}
            />
            <span className="max-w-40 truncate">{templateTitle(v)}</span>
            {v.hidden ? (
              <span className="text-muted-foreground">(hidden)</span>
            ) : null}
            <span className="text-muted-foreground tabular-nums">
              · {v.tokenIds.length}{" "}
              {v.tokenIds.length === 1 ? "creature" : "creatures"}
            </span>
          </button>
        </div>
      ))}
    </>
  )
}
