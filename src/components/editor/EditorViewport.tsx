/**
 * The editor's 3D viewport: an EngineCanvas wired to the editor store and controller.
 *  - document revisions → engine.updateScene(scene, lastChange) (full setScene after loads/syncs);
 *  - view options / active level → engine.setView(editorViewState(store));
 *  - controller overlays → engine.setOverlays; terrain previews → engine.previewTerrain; tools project
 *    world points with engine.project (controller.setProjector);
 *  - canvas pointer events → ToolPointerEvents (engine.pick on the active level, marching its terrain, +
 *    snapping, Alt = free; canvas-relative position and pressed buttons); the CSS cursor is the active
 *    tool's (Tool.cursor), else the default for the tool;
 *  - level backdrops → assets.getImage → createImageBitmap → engine.setLevelImage;
 *  - "Preview player view": player mode with host masks computed locally by core/vision.
 */
import * as React from "react"
import { toast } from "sonner"

import { EngineCanvas } from "@/components/canvas/EngineCanvas"
import { useEngine } from "@/components/canvas/engineContext"
import { useServices } from "@/app/services"
import { groundHeightAt, tokenViewLevelId } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import { editorViewState } from "@/editor/store"
import type { Engine, Quality, ViewState } from "@/render/contracts"

import { useEditorContext } from "./context"
import { loadLevelImage } from "./lib/levelImages"
import { cursorReadout, editorCursor, stripBackgroundFloor, toToolPointerEvent, type DomPointerLike } from "./lib/pointer"
import { createPreviewVision, type PreviewResult } from "./lib/preview"
import { applyExtras, extrasApply, newItemIds } from "./lib/toolExtras"
import { sameCursor, type ViewportInfoStore } from "./lib/viewportInfo"
import { toolMeta } from "./toolMeta"

export interface PreviewState {
  tokenId: Id
}

export interface EditorViewportProps {
  quality?: Quality
  preview: PreviewState | null
  onPreviewToken(id: Id): void
  onPreviewResult?(result: PreviewResult | null): void
  onEngine(engine: Engine | null): void
  info: ViewportInfoStore
  children?: React.ReactNode
}

export function EditorViewport({ quality, preview, onPreviewToken, onPreviewResult, onEngine, info, children }: EditorViewportProps) {
  return (
    <EngineCanvas quality={quality} onEngine={onEngine} className="bg-background">
      <ViewportBridge preview={preview} onPreviewToken={onPreviewToken} onPreviewResult={onPreviewResult} info={info} />
      {children}
    </EngineCanvas>
  )
}

/** CSS cursor of the canvas (skips redundant style writes). */
function setCursor(el: HTMLElement, css: string): void {
  if (el.style.cursor !== css) el.style.cursor = css
}

/** Pixels the right button may travel and still count as a click (finishes walls / rulers). */
const RIGHT_CLICK_SLOP = 5
const STATS_INTERVAL_MS = 250

function ViewportBridge({
  preview,
  onPreviewToken,
  onPreviewResult,
  info,
}: {
  preview: PreviewState | null
  onPreviewToken(id: Id): void
  onPreviewResult?(result: PreviewResult | null): void
  info: ViewportInfoStore
}) {
  const { engine, canvas } = useEngine()
  const { store, controller, extras } = useEditorContext()
  const { assets } = useServices()
  const previewTokenId = preview?.tokenId ?? null
  /** Bumped after every full engine.setScene so level images are re-applied. */
  const [imageEpoch, setImageEpoch] = React.useState(0)
  const previewRef = React.useRef<Id | null>(null)
  const onPreviewTokenRef = React.useRef(onPreviewToken)
  const onPreviewResultRef = React.useRef(onPreviewResult)

  React.useEffect(() => {
    previewRef.current = previewTokenId
    onPreviewTokenRef.current = onPreviewToken
    onPreviewResultRef.current = onPreviewResult
  })

  // ---- document + view → engine (edit mode) --------------------------------------------------
  const framedDoc = React.useRef<string | null>(null)
  const wasPreviewing = React.useRef(false)
  React.useEffect(() => {
    if (!engine) return
    if (previewTokenId) {
      wasPreviewing.current = true
      return
    }
    const s = store.getState()
    engine.setScene(s.scene)
    engine.setView(editorViewState(s))
    engine.setOverlays({ ...controller.overlays(), pendingMoves: {} })
    // The preview shares the top-down camera: give the editor its overview back.
    const leavingPreview = wasPreviewing.current && s.view.camera === "topdown"
    wasPreviewing.current = false
    if (framedDoc.current !== s.scene.id || leavingPreview) {
      framedDoc.current = s.scene.id
      engine.frameScene()
    }
    queueMicrotask(() => setImageEpoch((n) => n + 1))

    const unsubStore = store.subscribe((next, prev) => {
      if (next.scene !== prev.scene) {
        if (next.lastChange) {
          engine.updateScene(next.scene, next.lastChange)
        } else {
          engine.setScene(next.scene)
          if (framedDoc.current !== next.scene.id) {
            // Another document: drop any half-finished gesture (wall chain, ruler, drag).
            controller.cancelGesture()
            framedDoc.current = next.scene.id
            engine.frameScene()
          }
          setImageEpoch((n) => n + 1)
        }
      }
      if (next.view !== prev.view || next.activeLevelId !== prev.activeLevelId) engine.setView(editorViewState(next))
    })
    const unsubController = controller.subscribe(() => engine.setOverlays(controller.overlays()))
    controller.setTerrainPreview((levelId, heights, dirty) => engine.previewTerrain(levelId, heights, dirty))
    controller.setProjector((p) => engine.project(p))
    return () => {
      unsubStore()
      unsubController()
      controller.setTerrainPreview(null)
      controller.setProjector(null)
      controller.cancelGesture()
    }
  }, [engine, store, controller, previewTokenId])

  // ---- preview player view ---------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine || !previewTokenId) return
    const vision = createPreviewVision()
    let focused = false
    const run = (change: Parameters<typeof vision.compute>[2]) => {
      const s = store.getState()
      const token = Object.hasOwn(s.scene.tokens, previewTokenId) ? s.scene.tokens[previewTokenId] : null
      if (!token) return
      let result: PreviewResult
      try {
        result = vision.compute(s.scene, [previewTokenId], change)
      } catch (err) {
        console.error("[atlas] preview vision failed", err)
        toast.error("Could not compute this token's vision", { description: err instanceof Error ? err.message : String(err) })
        return
      }
      engine.setScene(result.scene)
      const view: Partial<ViewState> = {
        mode: "player",
        camera: "topdown",
        // The level the player's view cuts away at (the upper room from the top of a stair run).
        activeLevelId: tokenViewLevelId(result.scene, token),
        levelVisibility: {},
        ghostAdjacent: false,
        cutaway: true,
        showGrid: false,
        showHelpers: false,
        vision: "fog",
        viewerTokenIds: [previewTokenId],
        primaryViewerId: previewTokenId,
        hostMasks: result.masks,
        dimmedTokenIds: [],
      }
      engine.setView(view)
      engine.setOverlays({ selectedIds: [previewTokenId], hoveredId: null, preview: null, ruler: null, dragGhosts: {}, pendingMoves: {} })
      if (!focused) {
        focused = true
        const y = groundHeightAt(s.scene, token.levelId, token.position)
        engine.focus({ x: token.position.x, y, z: token.position.z }, { distance: 80, immediate: true })
      }
      setImageEpoch((n) => n + 1)
      onPreviewResultRef.current?.(result)
    }
    run(null)
    const unsub = store.subscribe((next, prev) => {
      if (next.scene !== prev.scene) run(next.lastChange)
    })
    return () => {
      unsub()
      vision.dispose()
      onPreviewResultRef.current?.(null)
    }
  }, [engine, store, previewTokenId])

  // ---- level backdrop images ------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine) return
    const applied = new Map<Id, string>()
    let disposed = false
    const warned = new Set<string>()
    const sync = () => {
      const s = store.getState()
      const sceneId = s.scene.id
      const present = new Set<Id>()
      for (const level of Object.values(s.scene.levels)) {
        const b = level.backdrop
        if (!b) continue
        present.add(level.id)
        const key = `${sceneId}/${b.assetId}|${b.rect.x},${b.rect.z},${b.rect.w},${b.rect.d}`
        if (applied.get(level.id) === key) continue
        applied.set(level.id, key)
        const rect = { ...b.rect }
        loadLevelImage(assets, sceneId, b.assetId)
          .then((bitmap) => {
            if (!disposed && applied.get(level.id) === key) engine.setLevelImage(level.id, bitmap, rect)
          })
          .catch((err: unknown) => {
            if (disposed || warned.has(b.assetId)) return
            warned.add(b.assetId)
            applied.delete(level.id)
            toast.error(`Could not load the map image of “${level.name}”`, { description: err instanceof Error ? err.message : String(err) })
          })
      }
      for (const levelId of [...applied.keys()]) {
        if (present.has(levelId)) continue
        applied.delete(levelId)
        engine.setLevelImage(levelId, null, null)
      }
    }
    sync()
    const unsub = store.subscribe((next, prev) => {
      if (next.scene.levels !== prev.scene.levels || next.scene.id !== prev.scene.id) sync()
    })
    return () => {
      disposed = true
      unsub()
    }
  }, [engine, store, assets, imageEpoch])

  // ---- frame stats ----------------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine) return
    let last = 0
    return engine.onFrame((stats) => {
      const now = performance.now()
      if (now - last < STATS_INTERVAL_MS) return
      last = now
      info.setState({ stats })
    })
  }, [engine, info])

  // ---- pointer input --------------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine || !canvas) return
    let leftDown = false
    let rightDown: { x: number; y: number } | null = null
    let pendingMove: PointerEvent | null = null
    let raf = 0
    /**
     * A press on an unselected floor (select tool): a drag is a marquee; a click deselects whatever was
     * selected, or selects the floor when nothing was (floors are the level's background).
     */
    let floorPress: { id: string; x: number; y: number } | null = null

    // Wall nodes, shapes and hover markers land where the cursor ray meets the terrain (terrain: true).
    const build = (e: DomPointerLike, button?: number) => {
      const s = store.getState()
      const pick = engine.pick(e.clientX, e.clientY, { levelId: s.activeLevelId, objects: true, tokens: true, terrain: true })
      return toToolPointerEvent(e, pick, { grid: s.scene.grid, snapMode: s.snapMode, altHeld: s.altHeld }, { button, origin: canvas.getBoundingClientRect() })
    }

    const refreshCursor = () => setCursor(canvas, previewRef.current ? "default" : editorCursor(controller, leftDown))

    const updateCursor = (ground: { x: number; z: number } | null) => {
      const next = cursorReadout(store.getState().scene.grid, ground)
      if (!sameCursor(next, info.getState().cursor)) info.setState({ cursor: next })
      refreshCursor()
    }
    // The tool's cursor follows its own state (terrain phases, hovers) and its settings (sub-tool switches).
    const unsubCursor = controller.subscribe(refreshCursor)

    /** Select tool: floors act as background (see stripBackgroundFloor). */
    const background = <E extends ReturnType<typeof build>>(ev: E) => {
      const s = store.getState()
      return s.tool === "select" ? stripBackgroundFloor(s.scene, s.selection, ev) : { event: ev, floorId: null }
    }

    const processMove = (e: PointerEvent) => {
      if (previewRef.current) return
      const ev = background(build(e)).event
      controller.pointerMove(ev)
      updateCursor(ev.ground)
    }

    const flushMove = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      const e = pendingMove
      pendingMove = null
      if (e) processMove(e)
    }

    const onPointerDown = (e: PointerEvent) => {
      if (previewRef.current) {
        if (e.button !== 0) return
        const pick = engine.pick(e.clientX, e.clientY, { levelId: store.getState().activeLevelId, objects: false, tokens: true })
        if (pick.tokenId && pick.tokenId !== previewRef.current) onPreviewTokenRef.current(pick.tokenId)
        return
      }
      if (e.button === 2) {
        rightDown = { x: e.clientX, y: e.clientY }
        return
      }
      if (e.button !== 0) return
      canvas.focus({ preventScroll: true })
      flushMove()
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic events (automation) have no active pointer to capture.
      }
      leftDown = true
      const stripped = background(build(e))
      const ev = stripped.event
      floorPress = stripped.floorId && store.getState().selection.length === 0 ? { id: stripped.floorId, x: e.clientX, y: e.clientY } : null
      const s = store.getState()
      const x = extras.getState()
      if (extrasApply(s.tool, x) && !s.readOnly) {
        // Place + apply the extra tool options as ONE undo step.
        const before = s.scene
        s.beginTransaction(`Add ${toolMeta(s.tool).label.toLowerCase()}`)
        try {
          controller.pointerDown(ev)
          const now = store.getState()
          const created = newItemIds(before, now.scene)
          if (created.objects.length + created.tokens.length > 0) now.apply((d) => applyExtras(d, created, x), "Tool options")
        } finally {
          store.getState().commitTransaction()
        }
      } else {
        controller.pointerDown(ev)
      }
      if (controller.activeTool().capturesPointer) engine.setCameraControlsEnabled(false)
      updateCursor(ev.ground)
    }

    const onPointerMove = (e: PointerEvent) => {
      pendingMove = e
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          const ev = pendingMove
          pendingMove = null
          if (ev) processMove(ev)
        })
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      if (previewRef.current) return
      flushMove()
      if (e.button === 2) {
        const start = rightDown
        rightDown = null
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= RIGHT_CLICK_SLOP) controller.pointerDown(build(e, 2))
        return
      }
      if (e.button !== 0 || !leftDown) return
      leftDown = false
      controller.pointerUp(background(build(e)).event)
      const press = floorPress
      floorPress = null
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4 && Object.hasOwn(store.getState().scene.objects, press.id)) store.getState().select([press.id])
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      engine.setCameraControlsEnabled(true)
    }

    const onPointerCancel = () => {
      if (!leftDown) return
      leftDown = false
      floorPress = null
      controller.cancelGesture()
      engine.setCameraControlsEnabled(true)
    }

    const onPointerLeave = (e: PointerEvent) => {
      if (leftDown || previewRef.current) return
      pendingMove = null
      // Clear hover previews when the pointer leaves the canvas.
      controller.pointerMove(
        toToolPointerEvent(
          e,
          { ground: null, objectId: null, tokenId: null, hitPoint: null },
          { grid: store.getState().scene.grid, snapMode: store.getState().snapMode, altHeld: false },
          { origin: canvas.getBoundingClientRect() }
        )
      )
      if (info.getState().cursor) info.setState({ cursor: null })
    }

    const onContextMenu = (e: Event) => e.preventDefault()

    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", onPointerUp)
    canvas.addEventListener("pointercancel", onPointerCancel)
    canvas.addEventListener("lostpointercapture", onPointerCancel)
    canvas.addEventListener("pointerleave", onPointerLeave)
    canvas.addEventListener("contextmenu", onContextMenu)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      unsubCursor()
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("pointermove", onPointerMove)
      canvas.removeEventListener("pointerup", onPointerUp)
      canvas.removeEventListener("pointercancel", onPointerCancel)
      canvas.removeEventListener("lostpointercapture", onPointerCancel)
      canvas.removeEventListener("pointerleave", onPointerLeave)
      canvas.removeEventListener("contextmenu", onContextMenu)
      engine.setCameraControlsEnabled(true)
    }
  }, [engine, canvas, store, controller, extras, info])

  // Tool switches while hovering (and entering / leaving the player preview): refresh the CSS cursor.
  React.useEffect(() => {
    if (!canvas) return
    const apply = () => setCursor(canvas, previewRef.current ? "default" : editorCursor(controller, false))
    apply()
    return store.subscribe((s, prev) => {
      if (s.tool !== prev.tool) apply()
    })
  }, [canvas, store, controller, previewTokenId])

  return null
}
