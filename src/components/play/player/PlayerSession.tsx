/**
 * The player's table (ARCHITECTURE §6.3, §8): one PlayerClient per session, the engine in "player"
 * mode with fog of war from the host masks, backdrop tiles composited by the client, and the play HUD.
 *
 *  - view → engine: the scene rebuilt from the PlayerView (incremental updates from the client's
 *    change hints), vision "fog" with hostMasks = view.masks, viewers = view.visionTokenIds, cutaway at
 *    the selected token's view level (core tokenViewLevelId: its own level, or the upper room from the
 *    top of a stair run), top-down camera following the selected token;
 *  - input: PlayController (select, drag-to-move or right-button move commands with A* preview +
 *    ruler, Alt for gridless moves when the DM allows them, measure, door clicks) → requestMove /
 *    requestDoor; a move with no path offers a jump (StrandedMove → requestJump); pending moves drawn
 *    dashed until the host answers; moved tokens walk along the route sent, or the planner's guess
 *    for moves this client did not make (tokenRouter);
 *  - results → toasts with friendly reasons;
 *  - the table: chat and dice (ChatDock; the host rolls), the initiative order (TurnStrip, turn ring
 *    on the acting token), and pings (a long press; others' pings arrive from the host).
 */
import * as React from "react"
import { toast } from "sonner"

import { useServices } from "@/app/services"
import { EngineCanvas } from "@/components/canvas/EngineCanvas"
import { useEngine } from "@/components/canvas/engineContext"
import { useQualityChoice } from "@/components/canvas/qualityChoice"
import { useSuppressThemeHotkey } from "@/components/theme-provider"
import { footprintCells, validateMove } from "@/core/movement"
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
  blindLandingOk,
  climbOptions,
  MovePlanner,
  PlayController,
  resolveSelection,
  SentRoutes,
  tokenRouter,
  tokensInReach,
  unexploredIn,
  cycleToken,
  type ClimbOption,
  type PlayTool,
} from "@/play"
import { backdropTexelBudget } from "@/render"
import type { Engine, Quality } from "@/render/contracts"

import { usePlayCanvasInput, usePlayKeys, zoomCanvas } from "../input"
import { StrandedMove } from "../StrandedMove"
import {
  EndedScreen,
  ErrorScreenOverlay,
  JoiningScreen,
  KickedScreen,
} from "../StatusScreens"
import {
  isBool,
  LiveBox,
  usePreference,
  useSessionResource,
} from "../useSessionResource"
import { entriesFromView } from "../table/chatModel"
import { levelShown, playerTurnOrder } from "../table/combatModel"
import { playerBadgeTokens, useStableBadges } from "../table/healthModel"
import { PingLayer, TokenBadges, TurnMarker } from "../table/MapMarkers"
import {
  linkTokens,
  requestTokenImage,
  useGameLink,
} from "../useTokenMakerLink"
import { PlayerHud } from "./PlayerHud"

const FOCUS_VIEW_HEIGHT = 70

/** Backdrop canvas pixels for a quality ceiling: just under the engine's texel cap, so it is uploaded as is. */
function backdropCanvasBudget(q: Quality): number {
  return Math.floor(backdropTexelBudget(q) * 0.99)
}

/** "Can't do that right now" while the player's own connection or the DM is away (null: go ahead). */
function offlineHint(snap: PlayerClientSnapshot): string | null {
  if (snap.networkOffline) return "You're offline, reconnecting…"
  if (snap.status === "live") return null
  return snap.status === "host-offline"
    ? "Waiting for the DM to reconnect"
    : "Reconnecting…"
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
  const [engine, setEngine] = React.useState<Engine | null>(null)
  const quality = useQualityChoice()
  const [ceiling, setCeiling] = React.useState<Quality | null>(null)
  useSuppressThemeHotkey()

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
  // Blind stairs landings: the upper storey's floor is known here only where this player explored.
  const [planner] = React.useState(
    () =>
      new MovePlanner({
        unexplored: (levelId, cell) =>
          unexploredIn(live.get().snap.view, levelId, cell),
      })
  )
  const [sentRoutes] = React.useState(() => new SentRoutes())
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
        freeMovement: () => live.get().snap.view?.flags.freeMovement ?? false,
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
          if (m.kind === "place") return
          const hint = offlineHint(live.get().snap)
          if (hint) {
            toast.info(hint, { id: "move-offline" })
            return
          }
          if (m.kind === "jump") {
            client.requestJump(m.tokenId, m.levelId, m.position)
            return
          }
          sentRoutes.remember(m.tokenId, m.route)
          client.requestMove(m.tokenId, m.path, m.end)
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
        onPing: (levelId, point) => {
          const hint = offlineHint(live.get().snap)
          if (hint) toast.info(hint, { id: "ping-offline" })
          else client.ping(levelId, { x: point.x, z: point.z })
        },
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

  // ---- Token Maker link: a Token Maker tab re-skins this player's tokens through this table ---------
  const makerRequests = React.useRef(new Set<string>())
  const linkGame = React.useMemo(
    () =>
      view && scene
        ? {
            sessionId: snap.sessionId,
            role: "player" as const,
            title: view.scene.name,
            userId: snap.userId,
            ready: snap.status === "live" && !snap.networkOffline,
            tokens: linkTokens(
              controlled
                .filter((id) => Object.hasOwn(scene.tokens, id))
                .map((id) => scene.tokens[id])
            ),
          }
        : null,
    [
      view,
      scene,
      controlled,
      snap.sessionId,
      snap.userId,
      snap.status,
      snap.networkOffline,
    ]
  )
  useGameLink(linkGame, (tokenId, imageUrl) =>
    requestTokenImage(client, tokenId, imageUrl, {
      // The Token Maker tab reports the outcome; no toast here.
      onRequest: (reqId) => makerRequests.current.add(reqId),
    })
  )

  // ---- the table ----------------------------------------------------------------------------------------
  const [chatFocus, setChatFocus] = React.useState(0)
  const chatEntries = React.useMemo(() => entriesFromView(view), [view])
  const turn = React.useMemo(() => playerTurnOrder(view), [view])
  const badges = useStableBadges(
    playerBadgeTokens(view, snap.scene?.grid.cellSize ?? 5)
  )
  const turnActive = turn?.entries.find((e) => e.id === turn.activeId) ?? null
  // "Your turn" once per turn of one of our characters.
  const turnKey =
    turn && turnActive?.mine ? `${turn.round}:${turnActive.id}` : null
  React.useEffect(() => {
    if (turnKey && turnActive)
      toast.success(`Your turn, ${turnActive.name || "adventurer"}!`, {
        id: "your-turn",
        // Clear of the chat dock (bottom-right) and the turn order (top-centre).
        position: "top-right",
      })
    // turnActive changes with every view; the key says when the turn did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey])

  // ---- request results → toasts ------------------------------------------------------------------
  const seen = React.useRef(new Set<string>())
  React.useEffect(() => {
    for (const r of snap.results) {
      if (seen.current.has(r.reqId)) continue
      seen.current.add(r.reqId)
      if (makerRequests.current.has(r.reqId)) continue
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
      case "chat":
        setChatFocus((n) => n + 1)
        return
      case "level":
      case "preview-vision":
        return false
    }
  })

  // ---- level changes (ladders, stairs/ramp top edges) -------------------------------------------
  const climbs: ClimbOption[] = React.useMemo(() => {
    if (!scene || !selectedToken) return []
    const options = climbOptions(scene, selectedToken)
    if (options.length === 0) return []
    // Only on a ladder or next to a stairs/ramp top edge: validate the step like the host will. A
    // stairs landing this player never explored has no known floor: the host decides (blind landing).
    const world = buildOcclusionWorld(scene)
    const k = footprintCells(selectedToken.size)
    return options.filter((o) =>
      blindLandingOk(
        validateMove(scene, world, selectedToken, o.path, {
          enforceSpeed: false,
        }),
        o.path,
        k,
        (levelId, cell) => unexploredIn(view, levelId, cell)
      )
    )
  }, [scene, selectedToken, view])
  const climb = (o: ClimbOption) => {
    if (!selectedToken) return
    if (snap.view?.flags.movementLocked) {
      toast.info("Movement is locked by the DM", { id: "move-locked" })
      return
    }
    const hint = offlineHint(snap)
    if (hint) {
      toast.info(hint, { id: "move-offline" })
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
          snap.networkOffline
            ? "You're offline, reconnecting…"
            : snap.status === "host-offline"
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
          sentRoutes={sentRoutes}
          controller={controller}
          activeLevelId={activeLevelId}
          selectedId={selectedId}
          grid={grid}
          canvasRef={canvasRef}
        />
        <StrandedMove controller={controller} />
        {scene ? (
          <TokenBadges
            tokens={badges}
            showOn={(levelId) => levelShown(scene, activeLevelId, levelId)}
          />
        ) : null}
        <PingLayer
          subscribe={client.onPing}
          scene={scene}
          onFocus={(p) => engine?.focus(p)}
        />
        {turn?.activeTokenId &&
        scene &&
        Object.hasOwn(scene.tokens, turn.activeTokenId) ? (
          <TurnMarker
            tokenId={turn.activeTokenId}
            radiusFt={
              (footprintCells(scene.tokens[turn.activeTokenId].size) *
                scene.grid.cellSize) /
              2
            }
            label={
              turnActive?.mine ? "Your turn" : turnActive?.name || "Their turn"
            }
            mine={turnActive?.mine ?? false}
            showOn={(levelId) => levelShown(scene, activeLevelId, levelId)}
          />
        ) : null}
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
            chat={{
              entries: chatEntries,
              focusSignal: chatFocus,
              disabledReason: offlineHint(snap),
              onSay: (text, audience) =>
                client.say(text, audience.kind === "all" ? "all" : "dm"),
              onRoll: (formula, audience) =>
                client.roll(formula, audience.kind === "all" ? "all" : "dm"),
            }}
            turn={turn}
            onEndTurn={() => {
              if (turnActive?.mine) client.endTurn(turnActive.id)
            }}
            onRollInitiative={(tokenId, bonus) =>
              client.rollInitiative(tokenId, bonus)
            }
            onFocusToken={(id) => focusToken(id)}
            onTokenStatus={(tokenId, change) =>
              client.changeTokenStatus(tokenId, change)
            }
            camera={{
              onRotate: (q) => engine?.rotateCamera(q),
              onZoom: (d) => zoomCanvas(canvasRef.current, d),
              onRecenter: () => focusToken(selectedId),
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
  sentRoutes,
  controller,
  activeLevelId,
  selectedId,
  grid,
  canvasRef,
}: {
  client: AtlasPlayerClient
  snap: PlayerClientSnapshot
  planner: MovePlanner
  sentRoutes: SentRoutes
  controller: PlayController
  activeLevelId: Id | null
  selectedId: Id | null
  grid: boolean
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
    // The planner first: moved tokens are routed (tokenRouter) while the engine takes the update.
    planner.setScene(scene, change)
    if (change) engine.updateScene(scene, change)
    else engine.setScene(scene)
    shown.current = { engine, scene }
    controller.sceneChanged()
  }, [engine, scene, client, planner, controller])

  // Moved tokens walk: along the route this client sent, else the planner's guess.
  React.useEffect(() => {
    if (!engine) return
    engine.setTokenRouter(tokenRouter(planner, sentRoutes))
    return () => engine.setTokenRouter(null)
  }, [engine, planner, sentRoutes])

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
      showHelpers: false,
      darkVision: false,
    })
  }, [engine, visionTokenIds, masks, activeLevelId, selectedId, grid])

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
