/**
 * The DM's host console (ARCHITECTURE §6.2, §8): one HostRunner per session (the authoritative host),
 * the live map in "dm-play" (everything visible, optional vision preview of any token), direct
 * manipulation (select, drag to move, door clicks, right-click menus), the session panel (room code,
 * players, tokens, table rules) and "Edit map" — the full editor tools against the live scene.
 */
import * as React from "react"
import { toast } from "sonner"
import { createStore } from "zustand/vanilla"
import { Crown } from "lucide-react"
import { useLocation } from "wouter"

import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useQualityChoice } from "@/components/canvas/qualityChoice"
import { EditorContext } from "@/components/editor/context"
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
import { sortedLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { createHostRunner, type HostRunnerImpl } from "@/net/host"
import { cycleToken, PlayController, type PlayTool } from "@/play"
import type { CameraKind, Engine, FrameStats } from "@/render/contracts"

import { CameraDock, HudPanel, ShortcutsButton, ToolSwitch } from "../hud"
import { usePlayKeys, zoomCanvas } from "../input"
import {
  BlockingScreen,
  EndedScreen,
  ErrorScreenOverlay,
  HomeButton,
  JoiningScreen,
} from "../StatusScreens"
import {
  isBool,
  isNum,
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
  const [mode, setMode] = React.useState<HostMode>("play")
  const [editor, setEditor] = React.useState<HostEditor | null>(null)
  const [levelChoice, setLevelChoice] = React.useState<Id | null>(null)
  const [selected, setSelected] = React.useState<Id | null>(null)
  const [preview, setPreview] = React.useState<Id[] | null>(null)
  const [keysOpen, setKeysOpen] = React.useState(false)
  const [previewInfo, setPreviewInfo] = React.useState<PreviewInfo | null>(null)
  const [camera, setCamera] = usePreference<CameraKind>(
    "atlas-host:camera",
    "topdown",
    (v): v is CameraKind => v === "topdown" || v === "orbit"
  )
  const [tilt, setTilt] = usePreference("atlas-host:tilt", 15, isNum)
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
        speedLimit: () => null,
        groundAt: (x, y, levelId) => {
          const g = live.get().engine?.pick(x, y, { levelId }).ground
          return g ? { x: g.x, z: g.z } : null
        },
        planner: null,
        onSelect: (id) => setSelected(id),
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
          if (controller.dragging || controller.getTool() === "measure")
            controller.cancel()
          else if (preview) setPreview(null)
          else if (selectedId) setSelected(null)
          else return false
          return
        case "preview-vision":
          togglePreview()
          return
      }
    },
    { enabled: mode === "play", host: true }
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
              tilt={tilt}
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
                  <div className="absolute inset-x-0 bottom-3 flex justify-center">
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
                      tilt={tilt}
                      onTilt={setTilt}
                      grid={grid}
                      onGrid={setGrid}
                    />
                    <HudPanel className="p-1">
                      <ShortcutsButton host />
                    </HudPanel>
                  </div>
                </div>
              )}
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
  return (
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
  )
}
