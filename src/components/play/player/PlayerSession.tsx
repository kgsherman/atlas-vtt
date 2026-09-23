/**
 * The player's table (ARCHITECTURE §6.3, §8): one PlayerClient per session, the engine in "player"
 * mode with fog of war from the host masks, backdrop tiles composited by the client, and the play HUD.
 *
 *  - view → engine: the scene rebuilt from the PlayerView (incremental updates from the client's
 *    change hints), vision "fog" with hostMasks = view.masks, viewers = view.visionTokenIds, cutaway at
 *    the selected token's view level (core tokenViewLevelId: its own level, or the upper room from the
 *    top of a stair run), top-down camera following the selected token;
 *  - input: PlayController (select, drag-to-move with A* preview + ruler, measure, door clicks) →
 *    requestMove / requestDoor; pending moves drawn dashed until the host answers;
 *  - results → toasts with friendly reasons.
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { EngineCanvas } from "@/components/canvas/EngineCanvas"
import { useEngine } from "@/components/canvas/engineContext"
import { useQualityChoice } from "@/components/canvas/qualityChoice"
import { validateMove } from "@/core/movement"
import { buildOcclusionWorld } from "@/core/occlusion"
import {
  sortedLevels,
  tokenGroundY,
  tokenViewLevelId,
} from "@/core/scene/queries"
import type { Id, SceneLike } from "@/core/scene/types"
import {
  bindBackdropsToEngine,
  createPlayerClient,
  describeRequestResult,
  pendingMovesOverlay,
  type AtlasPlayerClient,
  type PlayerClientSnapshot,
} from "@/net/player"
import {
  climbOptions,
  MovePlanner,
  PlayController,
  resolveSelection,
  tokensInReach,
  cycleToken,
  type ClimbOption,
  type PlayTool,
} from "@/play"
import { backdropTexelBudget } from "@/render"
import type { Engine, Quality } from "@/render/contracts"

import {
  usePlayCanvasInput,
  usePlayKeys,
  useGuardThemeHotkey,
  zoomCanvas,
} from "../input"
import {
  EndedScreen,
  ErrorScreenOverlay,
  JoiningScreen,
  KickedScreen,
} from "../StatusScreens"
import {
  isBool,
  isNum,
  LiveBox,
  usePreference,
  useSessionResource,
} from "../useSessionResource"
import { PlayerHud } from "./PlayerHud"

const DEG = Math.PI / 180
const FOCUS_VIEW_HEIGHT = 70

/** Backdrop canvas pixels for a quality ceiling: just under the engine's texel cap, so it is uploaded as is. */
function backdropCanvasBudget(q: Quality): number {
  return Math.floor(backdropTexelBudget(q) * 0.99)
}

declare global {
  interface Window {
    /** Dev-only automation handle for the player view. */
    __atlasPlayer?: {
      client: AtlasPlayerClient
      engine: Engine | null
      controller: PlayController
      planner: MovePlanner
      select(id: Id | null): void
    }
  }
}

export function PlayerSession({ sessionId }: { sessionId: string }) {
  const services = useServices()
  const client = useSessionResource(
    sessionId,
    () => {
      const c = createPlayerClient({
        sessionId,
        transport: services.transport,
        repo: services.sessions,
        identity: services.identity,
        tiles: services.tilesFor(sessionId),
        // Until the engine's quality ceiling is known, composite at the medium tier's texel budget
        // rather than the full map size (a weak device must not allocate a full-size canvas first).
        backdrop: { maxCanvasPixels: backdropCanvasBudget("medium") },
      })
      void c
        .start()
        .catch((err: unknown) =>
          console.error("[atlas] player client failed to start", err)
        )
      return c
    },
    (c) => void c.stop()
  )
  if (!client) return <JoiningScreen label="Joining the table…" />
  return <PlayerTable key={sessionId} client={client} />
}

function PlayerTable({ client }: { client: AtlasPlayerClient }) {
  const snap = React.useSyncExternalStore(client.subscribe, client.getSnapshot)
  const view = snap.view
  const [selected, setSelected] = React.useState<Id | null>(null)
  const [tool, setTool] = React.useState<PlayTool>("move")
  const [grid, setGrid] = usePreference("atlas-play:grid", true, isBool)
  const [tilt, setTilt] = usePreference("atlas-play:tilt", 15, isNum)
  const [engine, setEngine] = React.useState<Engine | null>(null)
  const quality = useQualityChoice()
  const [ceiling, setCeiling] = React.useState<Quality | null>(null)
  useGuardThemeHotkey()

  // Backdrop canvases follow the engine's quality ceiling (the engine caps textures at the same budget).
  React.useEffect(() => {
    if (ceiling) client.setBackdropBudget(backdropCanvasBudget(ceiling))
  }, [client, ceiling])

  const controlled = React.useMemo(
    () =>
      view
        ? view.controlledTokenIds.filter((id) => Object.hasOwn(view.tokens, id))
        : [],
    [view]
  )
  const selectedId = resolveSelection(selected, controlled)
  const scene = snap.scene
  const selectedToken =
    selectedId && scene && Object.hasOwn(scene.tokens, selectedId)
      ? scene.tokens[selectedId]
      : null
  // The view level: the token's level, or the upper room from the top rows of a stair run (its eye is
  // above that floor). Cutaway, measure/door picks and the planner's preferred drag level follow it.
  const activeLevelId =
    selectedToken && scene
      ? tokenViewLevelId(scene, selectedToken)
      : defaultLevel(scene)

  // ---- controller -----------------------------------------------------------------------------------
  const [live] = React.useState(
    () => new LiveBox({ snap, scene, activeLevelId, controlled, engine })
  )
  React.useEffect(() => {
    live.set({ snap, scene, activeLevelId, controlled, engine })
  })
  const [planner] = React.useState(() => new MovePlanner())
  const [controller] = React.useState(
    () =>
      new PlayController({
        role: "player",
        scene: () => live.get().scene,
        activeLevelId: () => live.get().activeLevelId,
        canSelect: (id) => live.get().controlled.includes(id),
        canDrag: (id) => live.get().controlled.includes(id),
        movementLocked: () =>
          live.get().snap.view?.flags.movementLocked ?? false,
        speedLimit: (id) => {
          const v = live.get().snap.view
          const t = v && Object.hasOwn(v.tokens, id) ? v.tokens[id] : null
          return v?.flags.enforceSpeed && t?.speed ? t.speed : null
        },
        groundAt: (x, y, levelId) => {
          const g = live.get().engine?.pick(x, y, { levelId }).ground
          return g ? { x: g.x, z: g.z } : null
        },
        planner,
        onSelect: (id) => setSelected(id),
        onMove: (m) => {
          if (m.kind !== "path") return
          const s = live.get().snap
          if (s.status !== "live") {
            toast.info(
              s.status === "host-offline"
                ? "Waiting for the DM to reconnect"
                : "Reconnecting…",
              { id: "move-offline" }
            )
            return
          }
          client.requestMove(m.tokenId, m.path)
        },
        onDoor: (hit) => {
          const s = live.get()
          if (!s.scene) return
          if (s.snap.view?.flags.movementLocked) {
            toast.info("Movement is locked by the DM", { id: "door-locked" })
            return
          }
          if (tokensInReach(s.scene, hit, s.controlled).length === 0) {
            toast.info("Move next to the door first", {
              id: "door-reach",
              description:
                "One of your characters must stand within one square of it.",
            })
            return
          }
          client.requestDoor(
            hit.door.id,
            hit.door.state === "open" ? "close" : "open"
          )
        },
        onHint: (message) => toast.info(message, { id: "play-hint" }),
        setCameraControls: (enabled) =>
          live.get().engine?.setCameraControlsEnabled(enabled),
      })
  )
  React.useEffect(
    () => controller.setSelected(selectedId),
    [controller, selectedId]
  )
  React.useEffect(
    () => controller.subscribe(() => setTool(controller.getTool())),
    [controller]
  )

  // ---- request results → toasts ------------------------------------------------------------------
  const seen = React.useRef(new Set<string>())
  React.useEffect(() => {
    for (const r of snap.results) {
      if (seen.current.has(r.reqId)) continue
      seen.current.add(r.reqId)
      const text = describeRequestResult(r)
      if (text) toast.error(text, { id: `req-${r.reqId}` })
    }
  }, [snap.results])

  // ---- camera ------------------------------------------------------------------------------------
  const focusToken = React.useCallback(
    (id: Id | null, immediate = false) => {
      const e = live.get().engine
      const s = live.get().scene
      if (!e || !s || !id || !Object.hasOwn(s.tokens, id)) return
      const t = s.tokens[id]
      if (!Object.hasOwn(s.levels, t.levelId)) return
      e.focus(
        { x: t.position.x, y: tokenGroundY(s, t), z: t.position.z },
        immediate ? { distance: FOCUS_VIEW_HEIGHT, immediate: true } : {}
      )
    },
    [live]
  )
  const focusedOnce = React.useRef(false)
  React.useEffect(() => {
    if (!engine || !selectedId || !scene) return
    if (!focusedOnce.current) {
      focusedOnce.current = true
      focusToken(selectedId, true)
    }
  }, [engine, selectedId, scene, focusToken])

  const selectToken = React.useCallback(
    (id: Id | null) => {
      setSelected(id)
      focusToken(id)
    },
    [focusToken]
  )

  // ---- keyboard ----------------------------------------------------------------------------------
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  usePlayKeys((action) => {
    const e = live.get().engine
    switch (action.type) {
      case "rotate":
        e?.rotateCamera(action.quarterTurns)
        return
      case "zoom":
        zoomCanvas(canvasRef.current, action.direction)
        return
      case "cycle-token": {
        const next = cycleToken(selectedId, live.get().controlled, action.dir)
        if (next) selectToken(next)
        return
      }
      case "toggle-measure":
        controller.setTool(
          controller.getTool() === "measure" ? "move" : "measure"
        )
        return
      case "tool":
        controller.setTool(action.tool)
        return
      case "focus-selected":
        focusToken(selectedId)
        return
      case "toggle-grid":
        setGrid(!grid)
        return
      case "cancel":
        controller.cancel()
        return
      case "level":
        return false
    }
  })

  // ---- level changes (ladders, stairs/ramp top edges) -------------------------------------------
  const climbs: ClimbOption[] = React.useMemo(() => {
    if (!scene || !selectedToken) return []
    const options = climbOptions(scene, selectedToken)
    if (options.length === 0) return []
    // Only on a ladder or next to a stairs/ramp top edge: validate the step like the host will.
    const world = buildOcclusionWorld(scene)
    return options.filter(
      (o) =>
        validateMove(scene, world, selectedToken, o.path, {
          enforceSpeed: false,
        }).ok
    )
  }, [scene, selectedToken])
  const climb = (o: ClimbOption) => {
    if (!selectedToken) return
    if (snap.view?.flags.movementLocked) {
      toast.info("Movement is locked by the DM", { id: "move-locked" })
      return
    }
    if (snap.status !== "live") {
      toast.info("Waiting for the DM to reconnect", { id: "move-offline" })
      return
    }
    client.requestMove(selectedToken.id, o.path)
  }

  // Dev automation handle.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__atlasPlayer = {
      client,
      engine,
      controller,
      planner,
      select: (id) => selectToken(id),
    }
    return () => {
      if (window.__atlasPlayer?.client === client) delete window.__atlasPlayer
    }
  }, [client, engine, controller, planner, selectToken])

  // ---- screens -----------------------------------------------------------------------------------
  const blocking =
    snap.status === "kicked" ? (
      <KickedScreen />
    ) : snap.status === "ended" ? (
      <EndedScreen />
    ) : snap.status === "error" ? (
      <ErrorScreenOverlay
        title="Can't join this session"
        message={snap.error}
        onRetry={() => location.reload()}
      />
    ) : !view ? (
      <JoiningScreen
        label={
          snap.status === "host-offline"
            ? "Waiting for the DM to open the table…"
            : snap.status === "syncing"
              ? "Syncing with the DM…"
              : "Connecting…"
        }
      />
    ) : null

  return (
    <div className="relative h-svh w-full overflow-hidden bg-black text-foreground">
      <EngineCanvas
        key={quality.engineKey}
        quality={quality.quality}
        onEngine={setEngine}
        onQualityCeiling={setCeiling}
        className="bg-black"
      >
        <PlayerBridge
          client={client}
          snap={snap}
          planner={planner}
          controller={controller}
          activeLevelId={activeLevelId}
          selectedId={selectedId}
          grid={grid}
          tilt={tilt}
          canvasRef={canvasRef}
        />
        {view && scene ? (
          <PlayerHud
            snap={snap}
            scene={scene}
            selectedId={selectedId}
            onSelect={selectToken}
            tool={tool}
            onTool={(t) => controller.setTool(t)}
            climbs={climbs}
            onClimb={climb}
            camera={{
              onRotate: (q) => engine?.rotateCamera(q),
              onZoom: (d) => zoomCanvas(canvasRef.current, d),
              onRecenter: () => focusToken(selectedId),
              tilt,
              onTilt: setTilt,
              grid,
              onGrid: setGrid,
              quality: {
                value: quality.choice,
                onChange: quality.setChoice,
                current: ceiling,
              },
            }}
          />
        ) : null}
        {blocking}
      </EngineCanvas>
    </div>
  )
}

function defaultLevel(scene: SceneLike | null): Id | null {
  if (!scene) return null
  const levels = sortedLevels(scene)
  return levels.find((l) => l.name)?.id ?? levels[0]?.id ?? null
}

/** Engine wiring (inside EngineCanvas so it can reach the canvas). */
function PlayerBridge({
  client,
  snap,
  planner,
  controller,
  activeLevelId,
  selectedId,
  grid,
  tilt,
  canvasRef,
}: {
  client: AtlasPlayerClient
  snap: PlayerClientSnapshot
  planner: MovePlanner
  controller: PlayController
  activeLevelId: Id | null
  selectedId: Id | null
  grid: boolean
  tilt: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}) {
  const { engine, canvas } = useEngine()
  React.useEffect(() => {
    canvasRef.current = canvas
  }, [canvas, canvasRef])

  // Scene: full build first, then incremental updates from the client's change hints.
  const shown = React.useRef<{ engine: Engine; scene: SceneLike } | null>(null)
  const scene = snap.scene
  React.useLayoutEffect(() => {
    if (!engine || !scene) return
    const prev =
      shown.current && shown.current.engine === engine
        ? shown.current.scene
        : null
    if (prev === scene) return
    const change = prev ? client.sceneChangeSince(prev) : null
    if (change) engine.updateScene(scene, change)
    else engine.setScene(scene)
    planner.setScene(scene, change)
    shown.current = { engine, scene }
    controller.sceneChanged()
  }, [engine, scene, client, planner, controller])

  // View: fog of war from the host masks; cutaway at the selected token's view level.
  const hasView = snap.view !== null
  const visionTokenIds = snap.view?.visionTokenIds
  const masks = snap.view?.masks
  React.useEffect(() => {
    if (!engine || !visionTokenIds || !masks) return
    engine.setView({
      mode: "player",
      camera: "topdown",
      activeLevelId,
      levelVisibility: {},
      ghostAdjacent: false,
      cutaway: true,
      showGrid: grid,
      vision: "fog",
      viewerTokenIds: visionTokenIds,
      hostMasks: masks,
      primaryViewerId: selectedId,
      dimmedTokenIds: [],
      tilt: tilt * DEG,
      showHelpers: false,
    })
  }, [engine, visionTokenIds, masks, activeLevelId, selectedId, grid, tilt])

  // Battlemap tiles.
  React.useEffect(
    () => (engine ? bindBackdropsToEngine(client, engine) : undefined),
    [engine, client]
  )

  // Overlays: controller (selection, drag ghost, ruler) + pending moves.
  const pending = React.useMemo(
    () => pendingMovesOverlay(snap.pending),
    [snap.pending]
  )
  React.useEffect(() => {
    if (!engine) return
    engine.setOverlays({ ...controller.overlays(), pendingMoves: pending })
    return controller.subscribe(() => engine.setOverlays(controller.overlays()))
  }, [engine, controller, pending])

  usePlayCanvasInput({
    engine,
    canvas,
    controller,
    activeLevelId: () => activeLevelId,
    enabled: hasView,
  })
  return null
}
