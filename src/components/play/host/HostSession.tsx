/**
 * The DM's host console (ARCHITECTURE §6.2, §8): one HostRunner per session (the authoritative host),
 * the live map in "dm-play" (everything visible, optional vision preview of any token), direct
 * manipulation (select, drag to move, door clicks, right-click menus), the session panel (room code,
 * players, tokens, combat, table rules), the table (chat & dice dock, initiative order, turn ring,
 * pings: a long press, Shift for "everyone look here"), areas of effect (TemplateLayer: everyone's
 * templates, tested against the host runner's occlusion world; the DM moves, hides, removes and rolls
 * damage for any of them) and "Edit map" — the full editor tools against the live scene.
 */
import * as React from "react"
import { toast } from "sonner"
import { createStore } from "zustand/vanilla"
import { Crown } from "lucide-react"
import { useLocation } from "wouter"

import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useQualityChoice } from "@/components/canvas/qualityChoice"
import {
  EditorContext,
  FreeAssetScopeContext,
} from "@/components/editor/context"
import { useEditorHotkeys } from "@/components/editor/useEditorHotkeys"
import { KeybindingsDialog } from "@/components/keybindings/KeybindingsDialog"
import { Sidebar as EditorSidebar } from "@/components/editor/Sidebar"
import { ToolOptionsBar } from "@/components/editor/ToolOptionsBar"
import { ToolRail } from "@/components/editor/ToolRail"
import {
  CameraControls,
  LevelSwitcher,
} from "@/components/editor/ViewportOverlays"
import { useSuppressThemeHotkey } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { footprintCells } from "@/core/movement/footprint"
import { sortedLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import { playerTokenImageAllowed } from "@/core/session/tokenImages"
import type { GameState, TableAudience } from "@/core/session/types"
import { createHostRunner, type HostRunnerImpl } from "@/net/host"
import {
  cycleToken,
  hostTemplateItems,
  inputOf,
  PlayController,
  specOf,
  templateInput,
  type PlayTool,
  type TemplateView,
} from "@/play"
import type { CameraKind, Engine, FrameStats } from "@/render/contracts"

import { CameraDock, HudPanel, ShortcutsButton, ToolSwitch } from "../hud"
import { usePlayKeys, zoomCanvas } from "../input"
import { ChatDock } from "../table/ChatDock"
import {
  dmAudiences,
  entriesFromState,
  type Audience,
} from "../table/chatModel"
import { dmTurnOrder, levelShown } from "../table/combatModel"
import { dmBadgeTokens, useStableBadges } from "../table/healthModel"
import {
  PingLayer,
  TokenBadges,
  TurnMarker,
  type MapPing,
} from "../table/MapMarkers"
import { TemplateLayer } from "../table/TemplateLayer"
import { TemplateCard, TemplatePicker } from "../table/TemplatePanels"
import { TurnStrip } from "../table/TurnStrip"
import { linkTokens, useGameLink } from "../useTokenMakerLink"
import {
  BlockingScreen,
  EndedScreen,
  ErrorScreenOverlay,
  HomeButton,
  JoiningScreen,
} from "../StatusScreens"
import {
  isBool,
  LiveBox,
  usePreference,
  useSessionResource,
} from "../useSessionResource"
import { createHostActions, tokenPoint } from "./hostActions"
import { HostStatusBar, HostTopBar, type HostMode } from "./HostChrome"
import {
  createHostEditor,
  useAdoptHostScene,
  type HostEditor,
  type HostEditorView,
} from "./hostEditor"
import { EndSessionDialog } from "./EndSessionDialog"
import { HostEditorProviders } from "./HostEditorProviders"
import {
  CameraKindSwitch,
  LevelRail,
  LockedPill,
  PreviewBanner,
  SelectedTokenCard,
} from "./HostOverlays"
import { HostViewport, type PreviewInfo } from "./HostViewport"
import { SessionPanel, type SessionTab } from "./SessionPanel"
import { useSaveMap } from "./useSaveMap"

declare global {
  interface Window {
    /** Dev-only automation handle for the host console. */
    __atlasHost?: {
      runner: HostRunnerImpl
      engine: Engine | null
      controller: PlayController
      editor: HostEditor | null
    }
  }
}

export function HostSession({ sessionId }: { sessionId: string }) {
  const services = useServices()
  const runner = useSessionResource(
    sessionId,
    () => {
      const r = createHostRunner({
        sessionId,
        transport: services.transport,
        repo: services.sessions,
        identity: services.identity,
        assets: services.assets,
        // "Save map to library" (HostRunner.saveMapToLibrary) writes to the scene library.
        scenes: services.scenes,
        tokenImageBase: services.tokenImages.publicBase,
      })
      void r
        .start()
        .catch((err: unknown) =>
          console.error("[atlas] host failed to start", err)
        )
      return r
    },
    (r) => void r.stop()
  )
  if (!runner) return <JoiningScreen label="Starting the session…" />
  return <HostTable key={sessionId} runner={runner} />
}

function defaultLevel(state: GameState): Id | null {
  const scene = state.scene
  const pcs = Object.values(scene.tokens).filter(
    (t) => t.kind === "pc" && !t.hidden
  )
  const counts = new Map<Id, number>()
  for (const t of pcs) counts.set(t.levelId, (counts.get(t.levelId) ?? 0) + 1)
  let best: Id | null = null
  let n = 0
  for (const [id, c] of counts)
    if (c > n && Object.hasOwn(scene.levels, id)) [best, n] = [id, c]
  if (best) return best
  const levels = sortedLevels(scene)
  let ground = levels[0]
  for (const l of levels)
    if (Math.abs(l.elevation) < Math.abs(ground.elevation)) ground = l
  return ground?.id ?? null
}

function HostTable({ runner }: { runner: HostRunnerImpl }) {
  const subscribe = React.useCallback(
    (l: () => void) => runner.subscribe(l),
    [runner]
  )
  const getSnapshot = React.useCallback(() => runner.getSnapshot(), [runner])
  const snap = React.useSyncExternalStore(subscribe, getSnapshot)
  const state = snap.state
  const [, navigate] = useLocation()

  const retry = () => void runner.takeOver()

  if (!state) {
    if (snap.status === "ended") return <EndedScreen who="You" />
    if (snap.status === "error") {
      const notDm = /not the DM/i.test(snap.error ?? "")
      return (
        <ErrorScreenOverlay
          title={notDm ? "This isn't your table" : "Can't host this session"}
          message={
            notDm
              ? "Only the DM who started this session can host it. If you were invited as a player, join with the room code instead."
              : snap.error
          }
          onRetry={notDm ? undefined : retry}
        />
      )
    }
    if (snap.status === "standby") {
      return (
        <BlockingScreen
          icon={<Crown />}
          title="This table is open in another tab"
          description={
            snap.error ??
            "Another tab or device is hosting this session. Take over to run it from here."
          }
          actions={
            <>
              <Button onClick={retry}>
                <Crown data-icon="inline-start" /> Take over hosting
              </Button>
              <HomeButton variant="outline" />
            </>
          }
        />
      )
    }
    return <JoiningScreen label="Starting the session…" />
  }
  return (
    <HostConsole
      runner={runner}
      snap={snap}
      state={state}
      navigate={navigate}
    />
  )
}

function HostConsole({
  runner,
  snap,
  state,
  navigate,
}: {
  runner: HostRunnerImpl
  snap: ReturnType<HostRunnerImpl["getSnapshot"]>
  state: GameState
  navigate: (to: string) => void
}) {
  const scene = state.scene
  const freeAssetScope = React.useMemo(
    () => state.freeAssets ?? [],
    [state.freeAssets]
  )
  const [mode, setMode] = React.useState<HostMode>("play")
  const [editor, setEditor] = React.useState<HostEditor | null>(null)
  const [levelChoice, setLevelChoice] = React.useState<Id | null>(null)
  const [selected, setSelected] = React.useState<Id | null>(null)
  /** The selected area of effect (its card replaces the token card). */
  const [templateId, setTemplateId] = React.useState<Id | null>(null)
  const [preview, setPreview] = React.useState<Id[] | null>(null)
  const [keysOpen, setKeysOpen] = React.useState(false)
  const [previewInfo, setPreviewInfo] = React.useState<PreviewInfo | null>(null)
  const [camera, setCamera] = usePreference<CameraKind>(
    "atlas-host:camera",
    "topdown",
    (v): v is CameraKind => v === "topdown" || v === "orbit"
  )
  const [grid, setGrid] = usePreference("atlas-host:grid", true, isBool)
  const [sidebar, setSidebar] = usePreference(
    "atlas-host:sidebar",
    true,
    isBool
  )
  const [tab, setTab] = React.useState<SessionTab>("players")
  const [tool, setTool] = React.useState<PlayTool>("move")
  const [engine, setEngine] = React.useState<Engine | null>(null)
  const [canvas, setCanvas] = React.useState<HTMLCanvasElement | null>(null)
  const [frame] = React.useState(() =>
    createStore<{ stats: FrameStats | null }>()(() => ({ stats: null }))
  )
  const hosting = snap.status === "hosting"
  const quality = useQualityChoice()
  useSuppressThemeHotkey()

  const activeLevelId =
    levelChoice && Object.hasOwn(scene.levels, levelChoice)
      ? levelChoice
      : defaultLevel(state)
  const selectedId =
    selected && Object.hasOwn(scene.tokens, selected) ? selected : null
  const previewIds = React.useMemo(
    () =>
      preview ? preview.filter((id) => Object.hasOwn(scene.tokens, id)) : null,
    [preview, scene.tokens]
  )
  const activePreview = previewIds && previewIds.length > 0 ? previewIds : null

  // ---- commands --------------------------------------------------------------------------------------
  const [live] = React.useState(
    () => new LiveBox({ state, activeLevelId, engine, hosting })
  )
  React.useEffect(() => {
    live.set({ state, activeLevelId, engine, hosting })
  })
  const actions = React.useMemo(
    () => createHostActions(runner, () => live.get().state),
    [runner, live]
  )
  const saveMap = useSaveMap(runner, snap)
  const [ending, setEnding] = React.useState(false)

  // ---- Token Maker link: a Token Maker tab re-skins any token through this console -------------------
  const services = useServices()
  const linkGame = React.useMemo(
    () => ({
      sessionId: snap.sessionId,
      role: "dm" as const,
      title: scene.name,
      userId: services.identity.userId,
      ready: hosting,
      tokens: linkTokens(Object.values(scene.tokens)),
    }),
    [
      snap.sessionId,
      scene.name,
      scene.tokens,
      services.identity.userId,
      hosting,
    ]
  )
  useGameLink(linkGame, async (tokenId, imageUrl) => {
    // Only the DM's own uploads (what the Token Maker produces), never an arbitrary URL.
    if (
      !playerTokenImageAllowed(
        imageUrl,
        services.tokenImages.publicBase,
        services.identity.userId
      )
    )
      return { ok: false, error: "That image isn't one of your token images." }
    const ok = actions.setTokenImage([tokenId], imageUrl)
    if (ok) toast.success("Token image updated from the Token Maker")
    return ok
      ? { ok: true, error: null }
      : { ok: false, error: "The table refused the image." }
  })
  const focusToken = React.useCallback(
    (id: Id) => {
      const s = live.get()
      const p = tokenPoint(s.state.scene, id)
      if (!p || !s.engine) return
      const t = s.state.scene.tokens[id]
      if (t.levelId !== s.activeLevelId) setLevelChoice(t.levelId)
      s.engine.focus(p, { distance: 60 })
    },
    [live]
  )
  const [controller] = React.useState(
    () =>
      new PlayController({
        role: "dm",
        scene: () => live.get().state.scene,
        activeLevelId: () => live.get().activeLevelId,
        canSelect: () => true,
        canDrag: () => live.get().hosting,
        movementLocked: () => false,
        freeMovement: () => true,
        speedLimit: () => null,
        groundAt: (x, y, levelId) => {
          const g = live.get().engine?.pick(x, y, { levelId }).ground
          return g ? { x: g.x, z: g.z } : null
        },
        planner: null,
        onSelect: (id) => {
          setSelected(id)
          if (id) setTemplateId(null)
        },
        onMove: (m) => {
          if (m.kind !== "place") return
          // Commit on the next frame: the engine must draw one frame without the drag ruler before the
          // scene update (render/overlays OverlayManager.sceneChanged() drops a pending ruler removal).
          requestAnimationFrame(() =>
            actions.moveToken(m.tokenId, m.levelId, m.position)
          )
        },
        onDoor: (hit) => {
          const d = hit.door
          if (d.state === "locked") {
            toast.info(`${d.name || "The door"} is locked`, {
              id: "door-locked",
              action: {
                label: "Unlock & open",
                onClick: () => actions.setDoor(d.id, "open"),
              },
            })
            return
          }
          actions.setDoor(d.id, d.state === "open" ? "closed" : "open")
        },
        onHint: (m) => toast.info(m, { id: "host-hint" }),
        setCameraControls: (enabled) =>
          live.get().engine?.setCameraControlsEnabled(enabled),
        onPing: (levelId, point, shift) => {
          if (live.get().hosting)
            actions.ping(levelId, { x: point.x, z: point.z }, shift)
        },
        onTemplate: (d, spec) => {
          const id = actions.placeTemplate(
            templateInput(d, spec),
            d.editing ? { id: d.editing } : {}
          )
          if (id) {
            setTemplateId(id)
            setSelected(null)
          }
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

  // ---- areas of effect ---------------------------------------------------------------------------------
  const templateItems = React.useMemo(
    () => hostTemplateItems(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.templates, state.players]
  )
  const [templateView, setTemplateView] = React.useState<TemplateView | null>(
    null
  )
  const templateSpec = React.useSyncExternalStore(controller.subscribe, () =>
    controller.getTemplateSpec()
  )
  // One card at a time at the bottom left: a token or an area.
  const selectTemplate = React.useCallback((id: Id | null) => {
    setTemplateId(id)
    if (id) setSelected(null)
  }, [])
  // A selected token takes the card's place.
  const shownTemplateId = selectedId ? null : templateId

  // ---- frame stats -----------------------------------------------------------------------------------
  React.useEffect(() => {
    if (!engine) return
    let last = 0
    return engine.onFrame((stats) => {
      const now = performance.now()
      if (now - last < 500) return
      last = now
      frame.setState({ stats })
    })
  }, [engine, frame])

  // ---- preview ---------------------------------------------------------------------------------------
  const togglePreview = React.useCallback(() => {
    if (preview) {
      setPreview(null)
      return
    }
    const s = live.get().state.scene
    const pcs = Object.values(s.tokens).filter((t) => t.kind === "pc")
    const id = selectedId ?? pcs[0]?.id ?? Object.keys(s.tokens)[0]
    if (!id) {
      toast.info("There are no tokens to preview")
      return
    }
    setPreview([id])
    focusToken(id)
  }, [preview, selectedId, live, focusToken])
  const previewToken = React.useCallback(
    (id: Id) => {
      setPreview([id])
      focusToken(id)
    },
    [focusToken]
  )

  // ---- edit mode -------------------------------------------------------------------------------------
  // The DM's editor view choices (ghosted adjacent levels, hidden levels) survive leaving Edit map.
  const [editView, setEditView] = React.useState<HostEditorView>({})
  const enterEdit = React.useCallback(() => {
    if (editor || !hosting) return
    controller.cancel()
    setPreview(null)
    setEditor(
      createHostEditor(runner, live.get().state.scene, {
        camera,
        activeLevelId,
        view: editView,
      })
    )
    setMode("edit")
  }, [
    editor,
    hosting,
    controller,
    runner,
    live,
    camera,
    activeLevelId,
    editView,
  ])
  const exitEdit = React.useCallback(() => {
    if (!editor) return
    setLevelChoice(editor.ctx.store.getState().activeLevelId)
    const view = editor.ctx.store.getState().view
    setEditView({
      ghostAdjacent: view.ghostAdjacent,
      levelVisibility: view.levelVisibility,
      darkVision: view.darkVision,
    })
    const cam = view.camera
    setCamera(cam)
    editor.dispose()
    setEditor(null)
    setMode("play")
  }, [editor, setCamera])
  React.useEffect(() => () => editor?.dispose(), [editor])
  // Hosting lost (standby / ended) while editing: leave edit mode.
  const exitEditRef = React.useRef(exitEdit)
  React.useEffect(() => {
    exitEditRef.current = exitEdit
  })
  React.useEffect(
    () =>
      runner.subscribe(() => {
        if (runner.getSnapshot().status !== "hosting") exitEditRef.current()
      }),
    [runner]
  )
  useAdoptHostScene(editor, scene)
  const saveToLibrary = React.useCallback(() => void saveMap.save(), [saveMap])
  useEditorHotkeys(editor?.ctx.controller ?? null, {
    enabled: true,
    save: saveToLibrary,
    help: () => setKeysOpen(true),
    escape: exitEdit,
  })

  // ---- keyboard (play mode) --------------------------------------------------------------------------
  /** Bumped by the Enter shortcut: opens the chat dock and focuses its input. */
  const [chatFocus, setChatFocus] = React.useState(0)
  usePlayKeys(
    (action) => {
      const e = live.get().engine
      switch (action.type) {
        case "rotate":
          e?.rotateCamera(action.quarterTurns)
          return
        case "zoom":
          zoomCanvas(canvas, action.direction)
          return
        case "toggle-grid":
          setGrid(!grid)
          return
        case "toggle-measure":
          controller.setTool(
            controller.getTool() === "measure" ? "move" : "measure"
          )
          return
        case "toggle-template":
          controller.setTool(
            controller.getTool() === "template" ? "move" : "template"
          )
          return
        case "tool":
          controller.setTool(action.tool)
          return
        case "focus-selected":
          if (selectedId) focusToken(selectedId)
          return
        case "cycle-token": {
          const pcs = Object.values(scene.tokens)
            .filter((t) => t.kind === "pc")
            .map((t) => t.id)
            .sort()
          const next = cycleToken(selectedId, pcs, action.dir)
          if (next) {
            setSelected(next)
            focusToken(next)
          }
          return
        }
        case "level": {
          const levels = sortedLevels(scene)
          const k = levels.findIndex((l) => l.id === activeLevelId)
          const next =
            levels[Math.min(levels.length - 1, Math.max(0, k + action.delta))]
          if (next) setLevelChoice(next.id)
          return
        }
        case "cancel":
          if (
            controller.dragging ||
            controller.getTool() === "measure" ||
            controller.getTool() === "template"
          )
            controller.cancel()
          else if (shownTemplateId) setTemplateId(null)
          else if (preview) setPreview(null)
          else if (selectedId) setSelected(null)
          else return false
          return
        case "preview-vision":
          togglePreview()
          return
        case "chat":
          setChatFocus((n) => n + 1)
          return
      }
    },
    { enabled: mode === "play", host: true }
  )

  // ---- the table ---------------------------------------------------------------------------------------
  // Rebuilt only when the table (or who plays) changes, not on every token step.
  const table = state.table
  const tablePlayersRec = state.players
  const chatEntries = React.useMemo(
    () => entriesFromState({ table, players: tablePlayersRec }),
    [table, tablePlayersRec]
  )
  const tablePlayers = React.useMemo(
    () =>
      Object.values(state.players)
        .map((p) => ({ userId: p.userId, name: p.displayName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [state.players]
  )
  const audiences = React.useMemo(
    () => dmAudiences(tablePlayers),
    [tablePlayers]
  )
  const toOf = (a: Audience): TableAudience =>
    a.kind === "all" ? "all" : a.kind === "player" ? [a.userId] : []
  const tokens = state.scene.tokens
  const turn = React.useMemo(
    () => dmTurnOrder({ table, scene: { tokens } }),
    [table, tokens]
  )
  const turnActive = turn?.entries.find((e) => e.id === turn.activeId) ?? null
  const badges = useStableBadges(dmBadgeTokens(state.scene))
  const subscribePings = React.useCallback(
    (cb: (p: MapPing) => void) =>
      runner.onPing((ev) => cb({ ...ev.ping, mine: ev.from === null })),
    [runner]
  )

  // ---- session actions -------------------------------------------------------------------------------
  /** End for everyone (after saving the map to the library when `save`); false = stay on the dialog. */
  const endSession = async (save: boolean): Promise<boolean> => {
    if (save && !(await saveMap.save({ confirm: false }))) return false
    try {
      await runner.endSession()
      toast.success("Session ended")
      return true
    } catch (err) {
      toast.error("Couldn't end the session", {
        description: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  // Dev automation handle.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__atlasHost = { runner, engine, controller, editor }
    return () => {
      if (window.__atlasHost?.runner === runner) delete window.__atlasHost
    }
  }, [runner, engine, controller, editor])

  const main = (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <HostTopBar
        snap={snap}
        sceneName={scene.name}
        mode={mode}
        onMode={(m) => (m === "edit" ? enterEdit() : exitEdit())}
        previewing={activePreview !== null}
        onPreview={togglePreview}
        sidebar={sidebar}
        onSidebar={setSidebar}
        onEnd={() => setEnding(true)}
        saveMap={saveMap}
      />
      <div className="flex min-h-0 flex-1">
        {editor ? <ToolRail /> : null}
        <main className="flex min-w-0 flex-1 flex-col">
          {editor ? <ToolOptionsBar /> : null}
          <div className="relative min-h-0 flex-1">
            <HostViewport
              key={quality.engineKey}
              quality={quality.quality}
              runner={runner}
              state={state}
              actions={actions}
              controller={controller}
              editor={editor}
              activeLevelId={activeLevelId}
              camera={camera}
              grid={grid}
              preview={activePreview}
              onPreviewInfo={setPreviewInfo}
              onEngine={setEngine}
              onCanvas={setCanvas}
              onPreviewToken={(ids) =>
                ids ? previewToken(ids[0]) : setPreview(null)
              }
              onSelectToken={(id) => setSelected(id)}
            >
              {editor ? (
                <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-3">
                  <LevelSwitcher />
                  <HudPanel className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="size-2 animate-pulse rounded-full bg-primary" />
                    Editing the live map — changes reach players as they explore
                    <Button size="xs" variant="outline" onClick={exitEdit}>
                      Done
                    </Button>
                  </HudPanel>
                  <CameraControls />
                </div>
              ) : (
                <div className="pointer-events-none absolute inset-0 z-10 select-none">
                  {/* One row: the banners start right of the level rail, so they never cover it. */}
                  <div className="absolute inset-x-3 top-3 flex items-start gap-3">
                    <div className="shrink-0">
                      <LevelRail
                        scene={scene}
                        activeLevelId={activeLevelId}
                        onLevel={setLevelChoice}
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
                      {turn ? (
                        <TurnStrip
                          role="dm"
                          round={turn.round}
                          activeId={turn.activeId}
                          entries={turn.entries}
                          onStep={(d) => actions.stepTurn(d)}
                          onFocus={focusToken}
                          disabled={!hosting}
                        />
                      ) : null}
                      {activePreview ? (
                        <PreviewBanner
                          scene={scene}
                          info={previewInfo}
                          tokenIds={activePreview}
                          onChange={(ids) => previewToken(ids[0])}
                          onExit={() => setPreview(null)}
                        />
                      ) : null}
                      {state.movementLocked ? <LockedPill /> : null}
                    </div>
                  </div>
                  {templateView && !selectedId ? (
                    <div className="absolute bottom-3 left-3">
                      <TemplateCard
                        key={templateView.id}
                        view={templateView}
                        scene={scene}
                        role="dm"
                        onClose={() => setTemplateId(null)}
                        onMove={() =>
                          controller.editTemplate(
                            templateView.id,
                            specOf(templateView),
                            templateView.source.angle
                          )
                        }
                        onRemove={() => {
                          actions.removeTemplates([templateView.id])
                          setTemplateId(null)
                        }}
                        onHidden={(hidden) =>
                          actions.placeTemplate(inputOf(templateView), {
                            id: templateView.id,
                            hidden,
                          })
                        }
                        onDamage={(formula, targets) => {
                          const r = actions.rollAreaDamage(formula, targets)
                          if (!r.ok) return r.error
                          toast.success(
                            `Rolled ${r.total} damage`,
                            {
                              id: "area-damage",
                              description:
                                r.hit === 0
                                  ? "No creature caught has tracked hit points."
                                  : `Dealt to ${r.hit} ${r.hit === 1 ? "creature" : "creatures"}.`,
                            }
                          )
                          return null
                        }}
                        onFocusToken={focusToken}
                        disabled={!hosting}
                      />
                    </div>
                  ) : null}
                  {selectedId ? (
                    <div className="absolute bottom-3 left-3">
                      <SelectedTokenCard
                        state={state}
                        tokenId={selectedId}
                        actions={actions}
                        onPreview={previewToken}
                        onClose={() => setSelected(null)}
                      />
                    </div>
                  ) : null}
                  <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-2">
                    {tool === "template" ? (
                      <TemplatePicker
                        spec={templateSpec}
                        onSpec={(sp) => controller.setTemplateSpec(sp)}
                        onClose={() => controller.setTool("move")}
                      />
                    ) : null}
                    <HudPanel className="flex items-center gap-1 p-1">
                      <ToolSwitch
                        tool={tool}
                        onTool={(t) => controller.setTool(t)}
                        disabledMove={!hosting}
                      />
                    </HudPanel>
                  </div>
                  <div className="absolute right-3 bottom-3 flex items-center gap-2">
                    <CameraKindSwitch
                      camera={camera}
                      onCamera={setCamera}
                      onFrame={() => engine?.frameScene()}
                    />
                    <CameraDock
                      onRotate={(q) => engine?.rotateCamera(q)}
                      onZoom={(d) => zoomCanvas(canvas, d)}
                      onRecenter={
                        selectedId ? () => focusToken(selectedId) : undefined
                      }
                      grid={grid}
                      onGrid={setGrid}
                    />
                    <HudPanel className="p-1">
                      <ShortcutsButton host />
                    </HudPanel>
                    <ChatDock
                      role="dm"
                      storageKey="atlas-host:chat"
                      entries={chatEntries}
                      audiences={audiences}
                      players={tablePlayers}
                      onSay={(text, a) => actions.say(text, toOf(a))}
                      onRoll={(formula, a) => {
                        const error = actions.roll(formula, toOf(a))
                        if (error) toast.error(error, { id: "dm-roll" })
                      }}
                      disabledReason={
                        hosting ? null : "This tab is not hosting the session."
                      }
                      focusSignal={chatFocus}
                    />
                  </div>
                </div>
              )}
              {!editor ? (
                <TokenBadges
                  tokens={badges}
                  showOn={(levelId) =>
                    levelShown(scene, activeLevelId, levelId)
                  }
                />
              ) : null}
              {!editor &&
              turn?.activeTokenId &&
              Object.hasOwn(scene.tokens, turn.activeTokenId) ? (
                <TurnMarker
                  tokenId={turn.activeTokenId}
                  radiusFt={
                    (footprintCells(scene.tokens[turn.activeTokenId].size) *
                      scene.grid.cellSize) /
                    2
                  }
                  label={turnActive?.name ?? ""}
                  mine={false}
                  showOn={(levelId) =>
                    levelShown(scene, activeLevelId, levelId)
                  }
                />
              ) : null}
              <PingLayer
                subscribe={subscribePings}
                scene={scene}
                onFocus={(p) => engine?.focus(p)}
              />
              <TemplateLayer
                controller={controller}
                scene={scene}
                items={templateItems}
                world={() => runner.occlusion()}
                selectedId={shownTemplateId}
                onSelect={selectTemplate}
                onSelectedView={setTemplateView}
                showOn={(levelId) => levelShown(scene, activeLevelId, levelId)}
                enabled={!editor}
              />
            </HostViewport>
            {snap.status === "ended" ? (
              <BlockingScreen
                icon={<Crown />}
                title="The session has ended"
                description="Players were disconnected. You can start a new session for this map from your library."
                actions={
                  <Button onClick={() => navigate(paths.home())}>
                    Back to home
                  </Button>
                }
              />
            ) : null}
          </div>
        </main>
        {sidebar ? (
          editor ? (
            <EditorSidebar />
          ) : (
            <SessionPanel
              snap={snap}
              state={state}
              actions={actions}
              tab={tab}
              onTab={setTab}
              selectedTokenId={selectedId}
              onSelectToken={(id) => setSelected(id)}
              onFocusToken={focusToken}
              onPreviewToken={previewToken}
              onKick={(uid) => runner.kick(uid)}
              onTakeOver={() => void runner.takeOver()}
              activeLevelId={activeLevelId}
            />
          )
        ) : null}
      </div>
      <KeybindingsDialog
        open={keysOpen}
        onOpenChange={setKeysOpen}
        scopes={["editor", "play"]}
        host
      />
      <EndSessionDialog
        open={ending}
        onOpenChange={setEnding}
        dirty={saveMap.dirty}
        canSave={saveMap.library.status === "linked"}
        sceneName={
          saveMap.library.status === "linked"
            ? saveMap.library.name
            : scene.name
        }
        onEnd={endSession}
      />
      <HostStatusBar
        snap={snap}
        frame={frame}
        quality={quality.choice}
        onQuality={quality.setChoice}
      />
    </div>
  )

  // The providers are always present (null while playing) so entering edit mode never remounts the map.
  // The inspector's asset pickers offer what this game loads (GameState.freeAssets).
  return (
    <FreeAssetScopeContext.Provider value={freeAssetScope}>
      <EditorContext.Provider value={editor ? editor.ctx : null}>
        <HostEditorProviders
          editor={editor}
          engine={engine}
          onPreviewToken={(id) => {
            exitEdit()
            previewToken(id)
          }}
          onExit={exitEdit}
          onSave={saveToLibrary}
          onShortcuts={() => setKeysOpen(true)}
        >
          {main}
        </HostEditorProviders>
      </EditorContext.Provider>
    </FreeAssetScopeContext.Provider>
  )
}
