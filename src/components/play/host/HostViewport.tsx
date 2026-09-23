/**
 * The DM's live viewport: one engine in "dm-play" (or "editor" while editing the map) showing the
 * authoritative GameState.scene. Scene revisions are applied incrementally (identity diff of immer
 * revisions); level backdrops come from the asset store; "preview vision" darkens what the previewed
 * tokens cannot perceive (masks from HostRunner.previewVisibility); input goes to the play controller
 * (select, drag-to-place, measure, door clicks) or, in edit mode, to the editor controller.
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { EngineCanvas } from "@/components/canvas/EngineCanvas"
import { useEngine } from "@/components/canvas/engineContext"
import { loadLevelImage } from "@/components/editor/lib/levelImages"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import type { Id, Scene } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { editorViewState } from "@/editor/store"
import type { HostRunnerImpl } from "@/net/host"
import {
  previewDimmedTokens,
  previewHostMasks,
  previewSeenTokens,
  sceneChangeBetween,
  isEmptyChange,
  type PlayController,
} from "@/play"
import type {
  CameraKind,
  Engine,
  HostLevelMasks,
  Quality,
} from "@/render/contracts"

import { usePlayCanvasInput } from "../input"
import { useHostEditInput } from "./editInput"
import type { HostEditor } from "./hostEditor"
import { HostContextMenuContent } from "./HostContextMenu"
import { resolveMenuTarget, type MenuTarget } from "./menuTarget"
import type { HostActions } from "./hostActions"

const DEG = Math.PI / 180

export interface PreviewInfo {
  tokenIds: Id[]
  visible: number
  ms: number
  pending: boolean
}

export interface HostViewportProps {
  runner: HostRunnerImpl
  state: GameState
  actions: HostActions
  controller: PlayController
  editor: HostEditor | null
  activeLevelId: Id | null
  camera: CameraKind
  tilt: number
  grid: boolean
  preview: Id[] | null
  quality?: Quality
  onPreviewInfo(info: PreviewInfo | null): void
  onEngine(engine: Engine | null): void
  onCanvas(canvas: HTMLCanvasElement | null): void
  onPreviewToken(ids: Id[] | null): void
  onSelectToken(id: Id | null): void
  children?: React.ReactNode
}

export function HostViewport(props: HostViewportProps) {
  const { editor, state, actions, onPreviewToken, onSelectToken } = props
  const [menu, setMenu] = React.useState<MenuTarget | null>(null)
  const engineRef = React.useRef<Engine | null>(null)
  const onEngine = props.onEngine
  const handleEngine = React.useCallback(
    (e: Engine | null) => {
      engineRef.current = e
      onEngine(e)
    },
    [onEngine]
  )
  return (
    <ContextMenu disabled={editor !== null}>
      <ContextMenuTrigger
        className="relative size-full"
        onContextMenu={(e) => {
          const engine = engineRef.current
          const target =
            !editor &&
            engine &&
            !e.nativeEvent.defaultPrevented &&
            props.activeLevelId
              ? resolveMenuTarget(
                  engine,
                  state.scene,
                  props.activeLevelId,
                  e.clientX,
                  e.clientY
                )
              : null
          if (!target) {
            e.preventBaseUIHandler()
            if (!editor) e.preventDefault()
            return
          }
          setMenu(target)
        }}
      >
        <EngineCanvas
          quality={props.quality}
          onEngine={handleEngine}
          className="bg-background"
        >
          <HostBridge {...props} />
          {props.children}
        </EngineCanvas>
      </ContextMenuTrigger>
      {menu ? (
        <HostContextMenuContent
          target={menu}
          state={state}
          actions={actions}
          onPreview={(id) => onPreviewToken([id])}
          onSelect={onSelectToken}
        />
      ) : null}
    </ContextMenu>
  )
}

function HostBridge({
  runner,
  state,
  controller,
  editor,
  activeLevelId,
  camera,
  tilt,
  grid,
  preview,
  onPreviewInfo,
  onCanvas,
}: HostViewportProps) {
  const { engine, canvas } = useEngine()
  const { assets, sessions } = useServices()
  const scene = state.scene

  React.useEffect(() => {
    onCanvas(canvas)
  }, [canvas, onCanvas])

  // ---- scene ---------------------------------------------------------------------------------------
  const shown = React.useRef<{ engine: Engine; scene: Scene } | null>(null)
  React.useLayoutEffect(() => {
    if (!engine) return
    const prev =
      shown.current && shown.current.engine === engine
        ? shown.current.scene
        : null
    if (prev === scene) return
    const change = sceneChangeBetween(prev, scene)
    if (!change) {
      engine.setScene(scene)
      if (!prev) engine.frameScene()
    } else if (!isEmptyChange(change)) {
      engine.updateScene(scene, change)
    }
    shown.current = { engine, scene }
    controller.sceneChanged()
  }, [engine, scene, controller])

  // ---- preview vision (masks from the host's vision worker) -----------------------------------------
  const [previewMasks, setPreviewMasks] = React.useState<{
    key: string
    masks: Record<Id, HostLevelMasks>
    dimmed: Id[]
  } | null>(null)
  const previewKey = preview ? preview.join(",") : null
  const onPreviewInfoRef = React.useRef(onPreviewInfo)
  React.useEffect(() => {
    onPreviewInfoRef.current = onPreviewInfo
  })
  const previewSeq = React.useRef(0)
  React.useEffect(() => {
    if (!previewKey || !preview) {
      onPreviewInfoRef.current(null)
      return
    }
    const seq = ++previewSeq.current
    const t0 = performance.now()
    onPreviewInfoRef.current({
      tokenIds: preview,
      visible: 0,
      ms: 0,
      pending: true,
    })
    runner
      .previewVisibility(preview)
      .then((result) => {
        if (seq !== previewSeq.current) return
        const masks = previewHostMasks(scene, result)
        const dimmed = previewDimmedTokens(scene, preview, result)
        setPreviewMasks({ key: previewKey, masks, dimmed })
        // Hidden tokens are never sent to players: not counted (and drawn dimmed, as DM-only).
        const visible = previewSeenTokens(scene, preview, result).length
        onPreviewInfoRef.current({
          tokenIds: preview,
          visible,
          ms: performance.now() - t0,
          pending: false,
        })
      })
      .catch((err: unknown) => {
        if (seq !== previewSeq.current) return
        toast.error("Couldn't compute that token's vision", {
          id: "preview-vision",
          description: err instanceof Error ? err.message : String(err),
        })
      })
    // Recomputed on every scene revision while previewing (the worker caches make this cheap).
  }, [runner, scene, previewKey, preview])

  // ---- view --------------------------------------------------------------------------------------
  const [editView, setEditView] = React.useState(0)
  React.useEffect(() => {
    if (!editor) return
    return editor.ctx.store.subscribe((s, prev) => {
      if (s.view !== prev.view || s.activeLevelId !== prev.activeLevelId)
        setEditView((n) => n + 1)
    })
  }, [editor])
  const masks =
    previewMasks && previewMasks.key === previewKey ? previewMasks : null
  React.useEffect(() => {
    if (!engine) return
    if (editor) {
      engine.setView({
        ...editorViewState(editor.ctx.store.getState()),
        vision: "off",
        viewerTokenIds: [],
        hostMasks: {},
        dimmedTokenIds: [],
        primaryViewerId: null,
        tilt: tilt * DEG,
      })
      return
    }
    const previewing = preview !== null && masks !== null
    engine.setView({
      mode: "dm-play",
      camera,
      activeLevelId,
      levelVisibility: {},
      ghostAdjacent: false,
      cutaway: true,
      showGrid: grid,
      showHelpers: false,
      vision: previewing ? "preview" : "off",
      viewerTokenIds: previewing ? preview : [],
      hostMasks: previewing ? masks.masks : {},
      dimmedTokenIds: previewing ? masks.dimmed : [],
      primaryViewerId: previewing ? (preview[0] ?? null) : null,
      tilt: tilt * DEG,
    })
  }, [
    engine,
    editor,
    editView,
    camera,
    activeLevelId,
    grid,
    tilt,
    preview,
    masks,
  ])

  // ---- overlays ----------------------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine) return
    if (editor) {
      const { controller: ec } = editor.ctx
      engine.setOverlays({ ...ec.overlays(), pendingMoves: {} })
      const off = ec.subscribe(() => engine.setOverlays(ec.overlays()))
      ec.setTerrainPreview((levelId, heights, dirty) =>
        engine.previewTerrain(levelId, heights, dirty)
      )
      return () => {
        off()
        ec.setTerrainPreview(null)
      }
    }
    engine.setOverlays({ ...controller.overlays(), pendingMoves: {} })
    return controller.subscribe(() => engine.setOverlays(controller.overlays()))
  }, [engine, editor, controller])

  // ---- level backdrops (the DM sees whole images) ------------------------------------------------
  const [rowSceneId, setRowSceneId] = React.useState<string | null | undefined>(
    undefined
  )
  const hasBackdrops = Object.values(scene.levels).some((l) => l.backdrop)
  React.useEffect(() => {
    if (!hasBackdrops || rowSceneId !== undefined) return
    let alive = true
    sessions
      .listMySessions()
      .then((list) => {
        if (alive)
          setRowSceneId(
            list.find((s) => s.id === state.sessionId)?.sceneId ?? null
          )
      })
      .catch(() => {
        if (alive) setRowSceneId(null)
      })
    return () => {
      alive = false
    }
  }, [hasBackdrops, rowSceneId, sessions, state.sessionId])
  const applied = React.useRef(new Map<Id, string>())
  React.useEffect(() => {
    if (!engine) return
    const current = applied.current
    const present = new Set<Id>()
    const sceneIds = [scene.id, rowSceneId].filter(
      (s): s is string => typeof s === "string"
    )
    for (const level of Object.values(scene.levels)) {
      const b = level.backdrop
      if (!b) continue
      present.add(level.id)
      const key = `${b.assetId}|${b.rect.x},${b.rect.z},${b.rect.w},${b.rect.d}|${b.opacity}|${b.tintWalls}`
      if (current.get(level.id) === key) continue
      current.set(level.id, key)
      const rect = { ...b.rect }
      void (async () => {
        let lastErr: unknown = null
        for (const sid of sceneIds) {
          try {
            const bitmap = await loadLevelImage(assets, sid, b.assetId)
            if (current.get(level.id) === key)
              engine.setLevelImage(level.id, bitmap, rect, {
                opacity: b.opacity,
                tintWalls: b.tintWalls,
              })
            return
          } catch (err) {
            lastErr = err
          }
        }
        if (current.get(level.id) === key && rowSceneId !== undefined) {
          current.delete(level.id)
          toast.error(`Couldn't load the map image of “${level.name}”`, {
            id: `backdrop-${level.id}`,
            description: lastErr instanceof Error ? lastErr.message : undefined,
          })
        } else if (current.get(level.id) === key) {
          // The library scene id is still being looked up: retry once it is known.
          current.delete(level.id)
        }
      })()
    }
    for (const levelId of [...current.keys()]) {
      if (present.has(levelId)) continue
      current.delete(levelId)
      engine.setLevelImage(levelId, null, null)
    }
  }, [engine, scene.levels, scene.id, rowSceneId, assets])

  // ---- input -------------------------------------------------------------------------------------
  usePlayCanvasInput({
    engine,
    canvas,
    controller,
    activeLevelId: () => activeLevelId,
    enabled: editor === null,
  })
  useHostEditInput(engine, canvas, editor ? editor.ctx : null)
  return null
}
