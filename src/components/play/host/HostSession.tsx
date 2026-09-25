/**
 * The map screen (ARCHITECTURE §6.8, §7, §8): the DM's one place for a map. One HostRunner per table
 * (the authoritative host) runs whether the table's doors are open or closed; the DM switches between
 * two views of the same live map with Edit / Play (Tab):
 *  - Edit: the editor's tools, panels and menus against the live map (a host editor kept for the whole
 *    visit, so undo survives switching back and forth), map image import, version history, sharing;
 *  - Play: the map in "dm-play" (everything visible, optional vision preview of any token), direct
 *    manipulation (select, drag to move, door clicks, right-click menus), the session panel (room code,
 *    players, tokens, combat, table rules, assets), the table (chat & dice dock, initiative order, turn
 *    ring, pings: a long press, Shift for "everyone look here"), areas of effect (TemplateLayer) and
 *    "Change map" (ChangeMapDialog: another library map, the party carried along).
 * "Open the table" lets players in with the room code; "Close the table" disconnects them and keeps the
 * DM here. The map saves itself with the game; restore points (library versions) are kept on Ctrl+S,
 * when the table closes, on a map change and when the DM leaves.
 */
import * as React from "react"
import { toast } from "sonner"
import { createStore } from "zustand/vanilla"
import { Crown, DoorClosed, ImagePlus } from "lucide-react"
import { useLocation, useSearch } from "wouter"

import { copyText } from "@/app/clipboard"
import { plural } from "@/app/format"
import { userMessage } from "@/app/library"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useQualityChoice } from "@/components/canvas/qualityChoice"
import {
  EditorContext,
  FreeAssetScopeContext,
} from "@/components/editor/context"
import {
  MapImportDialog,
  type MapImportRequest,
} from "@/components/editor/dialogs/MapImportDialog"
import { ShareDialog } from "@/components/editor/dialogs/ShareDialog"
import { VersionHistorySheet } from "@/components/editor/dialogs/VersionHistorySheet"
import { describeIssues } from "@/components/editor/lib/format"
import { isTextEntryTarget } from "@/components/editor/lib/pointer"
import { inTerrainMode } from "@/components/editor/lib/terrainMode"
import {
  readEditorView,
  writeEditorView,
} from "@/components/editor/lib/viewPrefs"
import { useEditorHotkeys } from "@/components/editor/useEditorHotkeys"
import { KeybindingsDialog } from "@/components/keybindings/KeybindingsDialog"
import { Sidebar as EditorSidebar } from "@/components/editor/Sidebar"
import { EditStatusItems } from "@/components/editor/StatusBar"
import { ToolOptionsBar } from "@/components/editor/ToolOptionsBar"
import { ToolRail } from "@/components/editor/ToolRail"
import {
  CameraControls,
  GettingStarted,
  LevelSwitcher,
} from "@/components/editor/ViewportOverlays"
import { useSuppressThemeHotkey } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { footprintCells } from "@/core/movement/footprint"
import { groundHeightAt, sortedLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { Arrival } from "@/core/session/changeMap"
import { playerTokenImageAllowed } from "@/core/session/tokenImages"
import type { GameState, TableAudience } from "@/core/session/types"
import type { EditorController } from "@/editor/controller"
import type { EditorStore } from "@/editor/store"
import { overlayOpen } from "@/lib/hotkeys"
import { createHostRunner, type HostRunnerImpl } from "@/net/host"
import { formatRoomCode } from "@/net/sessionsRepo"
import {
  cycleToken,
  hostTemplateItems,
  inputOf,
  PlayController,
  specOf,
  templateInput,
  tokenDisplayName,
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
import { ChangeMapDialog } from "./ChangeMapDialog"
import {
  changeMapErrorText,
  type ChangeMapOutcome,
  type ChangeMapRequest,
} from "./changeMapModel"
import { createHostActions, tokenPoint } from "./hostActions"
import { HostStatusBar, HostTopBar, type HostMode } from "./HostChrome"
import {
  createHostEditor,
  useAdoptHostScene,
  type HostEditor,
} from "./hostEditor"
import {
  HostEditorProviders,
  type MapScreenCommands,
} from "./HostEditorProviders"
import {
  CameraKindSwitch,
  LevelRail,
  LockedPill,
  PreviewBanner,
  SelectedTokenCard,
} from "./HostOverlays"
import { HostViewport, type PreviewInfo } from "./HostViewport"
import { SessionPanel, type SessionTab } from "./SessionPanel"
import {
  CloseTableDialog,
  LeaveTableDialog,
  type LeaveChoice,
} from "./TableDialogs"
import { useMapDocument } from "./useMapDocument"
import { useSaveMap } from "./useSaveMap"

declare global {
  interface Window {
    /** Dev-only automation handle for the map screen. */
    __atlasHost?: {
      runner: HostRunnerImpl
      engine: Engine | null
      controller: PlayController
      editor: HostEditor | null
      mode: HostMode
      setMode(mode: HostMode): void
    }
    /** Dev-only automation handle for the map screen's editor (while it exists). */
    __atlasEditor?: {
      store: EditorStore
      controller: EditorController
      engine: Engine | null
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
        // Restore points (HostRunner.saveMapToLibrary) go to the scene library.
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
  if (!runner) return <JoiningScreen label="Opening the table…" />
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

function TableEnded() {
  return (
    <BlockingScreen
      icon={<DoorClosed />}
      title="This table has ended"
      description="Its map was deleted, or it moved to another table. Open the map again from your library."
      actions={<HomeButton />}
    />
  )
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
    if (snap.status === "ended") return <TableEnded />
    if (snap.status === "error") {
      const notDm = /not the DM/i.test(snap.error ?? "")
      return (
        <ErrorScreenOverlay
          title={notDm ? "This isn't your table" : "Can't open this table"}
          message={
            notDm
              ? "Only the DM whose map this is can run its table. If you were invited as a player, join with the room code instead."
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
          title="This map is open in another tab"
          description={
            snap.error ??
            "Another tab or device is running this table. Take over to run it from here."
          }
          actions={
            <>
              <Button onClick={retry}>
                <Crown data-icon="inline-start" /> Take over
              </Button>
              <HomeButton variant="outline" />
            </>
          }
        />
      )
    }
    return <JoiningScreen label="Opening the table…" />
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

const modeKey = (sessionId: string) => `atlas-table:mode:${sessionId}`

/**
 * The mode to open in: Edit for ?import=1, else ?mode=, else the one last used at this table on this
 * device, else Play while the table is open and Edit otherwise.
 */
function initialMode(
  sessionId: string,
  tableOpen: boolean,
  search: string
): HostMode {
  const q = new URLSearchParams(search)
  if (q.get("import") === "1") return "edit"
  const asked = q.get("mode")
  if (asked === "edit" || asked === "play") return asked
  try {
    const saved = localStorage.getItem(modeKey(sessionId))
    if (saved === "edit" || saved === "play") return saved
  } catch {
    // Storage blocked: the default.
  }
  return tableOpen ? "play" : "edit"
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
  navigate: (to: string, opts?: { replace?: boolean }) => void
}) {
  const scene = state.scene
  const services = useServices()
  const search = useSearch()
  const freeAssetScope = React.useMemo(
    () => state.freeAssets ?? [],
    [state.freeAssets]
  )
  const [mode, setModeState] = React.useState<HostMode>(() =>
    initialMode(snap.sessionId, snap.tableOpen, search)
  )
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
    () => new LiveBox({ state, activeLevelId, engine, hosting, camera })
  )
  React.useEffect(() => {
    live.set({ state, activeLevelId, engine, hosting, camera })
  })
  const actions = React.useMemo(
    () => createHostActions(runner, () => live.get().state),
    [runner, live]
  )
  const saveMap = useSaveMap(runner, snap)
  const [changing, setChanging] = React.useState(false)
  const [closingTable, setClosingTable] = React.useState(false)
  const [leaveTo, setLeaveTo] = React.useState<string | null>(null)
  const [versionsOpen, setVersionsOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  // /map/new?import=1: the map image import builds the new map.
  const [importRequest, setImportRequest] =
    React.useState<MapImportRequest | null>(() =>
      new URLSearchParams(search).get("import") === "1" ? { mode: "new" } : null
    )
  const fileRef = React.useRef<HTMLInputElement | null>(null)
  // Hosting lost (standby / ended): the dialog closes and stays closed when hosting resumes.
  if (changing && !hosting) setChanging(false)
  const playersAtTable = snap.members.filter(
    (m) => m.status === "active" && m.online
  ).length

  // ---- the editor: one per map for the whole visit (undo survives Edit ↔ Play) ------------------------
  // Disposed while a map change swaps the document (its undo history belongs to the old map).
  const [swapping, setSwapping] = React.useState(false)
  const editorKey = hosting && !swapping ? scene.id : null
  const editor = useSessionResource(
    editorKey,
    () => {
      const at = live.get()
      const mapId = at.state.scene.id
      // The DM's view choices for this map on this device (the camera kind is the screen's, shared by both modes).
      const { camera: _savedCamera, ...saved } = readEditorView(mapId) ?? {}
      void _savedCamera
      const e = createHostEditor(runner, at.state.scene, {
        camera: at.camera,
        activeLevelId: at.activeLevelId,
        view: saved,
      })
      const off = e.ctx.store.subscribe((st, prev) => {
        const v = st.view
        const p = prev.view
        if (
          v.showGrid !== p.showGrid ||
          v.showHelpers !== p.showHelpers ||
          v.ghostAdjacent !== p.ghostAdjacent ||
          v.darkVision !== p.darkVision
        )
          writeEditorView(mapId, v)
      })
      return {
        ...e,
        dispose() {
          off()
          e.dispose()
        },
      }
    },
    (e) => e.dispose()
  )
  useAdoptHostScene(editor, scene)
  const editing = mode === "edit" && editor !== null

  const setMode = React.useCallback(
    (next: HostMode) => {
      setModeState(next)
      try {
        localStorage.setItem(modeKey(snap.sessionId), next)
      } catch {
        // Storage blocked: not remembered.
      }
    },
    [snap.sessionId]
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

  /** Edit ↔ Play: the same map, camera and level; gestures under way are cancelled. */
  const switchMode = React.useCallback(
    (next: HostMode) => {
      if (next === mode) return
      if (next === "edit") {
        if (!hosting || !editor) {
          toast.info("This tab isn't running the table", { id: "mode" })
          return
        }
        controller.cancel()
        setPreview(null)
        const st = editor.ctx.store.getState()
        if (st.view.camera !== camera) st.setView({ camera })
        if (
          activeLevelId &&
          st.activeLevelId !== activeLevelId &&
          Object.hasOwn(st.scene.levels, activeLevelId)
        )
          st.setActiveLevel(activeLevelId)
      } else if (editor) {
        editor.ctx.controller.cancelGesture()
        const st = editor.ctx.store.getState()
        setLevelChoice(st.activeLevelId)
        setCamera(st.view.camera)
      }
      setMode(next)
    },
    [
      mode,
      hosting,
      editor,
      controller,
      camera,
      activeLevelId,
      setMode,
      setCamera,
    ]
  )
  // Editing needs this tab to run the table.
  if (mode === "edit" && !hosting && snap.status !== "starting")
    setModeState("play")

  // ---- Token Maker link: a Token Maker tab re-skins any token through this screen --------------------
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

  // ---- the table's doors and leaving -----------------------------------------------------------------
  const openTable = React.useCallback(async () => {
    try {
      await runner.setTableOpen(true)
    } catch (err) {
      toast.error("Couldn't open the table", { description: userMessage(err) })
      return
    }
    const code = runner.getSnapshot().roomCode
    toast.success(`The table is open · ${formatRoomCode(code)}`, {
      description: "Players join with the room code.",
      action: {
        label: "Copy invite link",
        onClick: () =>
          void copyText(
            inviteLink(window.location.origin, code, withModeParam("")),
            "Invite link"
          ),
      },
    })
  }, [runner])
  const closeTable = React.useCallback(async (): Promise<boolean> => {
    try {
      await runner.setTableOpen(false)
    } catch (err) {
      toast.error("Couldn't close the table", { description: userMessage(err) })
      return false
    }
    toast.success("The table is closed", {
      description:
        "Players were disconnected. They come back with the same room code when you open it again.",
    })
    if (saveMap.dirty) void saveMap.save({ quiet: true })
    return true
  }, [runner, saveMap])
  /** Leave for another page: a restore point first when the map changed (the game itself is saved anyway). */
  const leaveNow = React.useCallback(
    async (to: string, choice: LeaveChoice = "keep"): Promise<boolean> => {
      if (choice === "close" && !(await closeTable())) return false
      if (live.get().hosting && saveMap.dirty)
        await saveMap.save({ quiet: true })
      navigate(to)
      return true
    },
    [closeTable, live, saveMap, navigate]
  )
  const go = React.useCallback(
    (to: string) => {
      if (hosting && snap.tableOpen) setLeaveTo(to)
      else void leaveNow(to)
    },
    [hosting, snap.tableOpen, leaveNow]
  )
  const doc = useMapDocument({ snap, editor, saveMap, go })
  const saveRestorePoint = React.useCallback(
    () => void saveMap.save(),
    [saveMap]
  )

  // ---- keyboard ------------------------------------------------------------------------------------------
  useEditorHotkeys(editor?.ctx.controller ?? null, {
    enabled: editing,
    save: saveRestorePoint,
    help: () => setKeysOpen(true),
    mode: () => switchMode("play"),
  })
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
        case "mode":
          switchMode("edit")
          return
      }
    },
    { enabled: !editing, host: true }
  )

  // ---- Edit: system clipboard pastes of copied Atlas objects ------------------------------------------------
  React.useEffect(() => {
    if (!editing || !editor) return
    const { store, controller: ec } = editor.ctx
    const onPaste = (e: ClipboardEvent) => {
      // Terrain mode: shapes are not on the clipboard, and the object selection is hidden (not a paste target).
      if (
        isTextEntryTarget(e.target) ||
        overlayOpen() ||
        inTerrainMode(store.getState())
      )
        return
      const text = e.clipboardData?.getData("text/plain")
      if (!text || !text.includes("atlas-clipboard")) return
      e.preventDefault()
      const r = store.getState().pasteText(text, ec.pasteTarget())
      if (!r.ok)
        toast.error("Could not paste", {
          description: describeIssues(r.issues),
        })
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [editing, editor])

  // ?mode= and ?import=1 were read when the screen opened: the address drops them.
  React.useEffect(() => {
    const q = new URLSearchParams(search)
    if (q.has("mode") || q.has("import"))
      navigate(paths.host(snap.sessionId), { replace: true })
  }, [search, navigate, snap.sessionId])

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

  // ---- changing the map --------------------------------------------------------------------------------
  /**
   * Move the table to another map (ChangeMapDialog), after saving a restore point of this one when
   * `req.save`. The host builds the change from its own live state (a player's change a moment ago
   * travels too). Resolves true once changed (the game's save goes on in the background); an error
   * text keeps the dialog open.
   */
  const pendingFocus = React.useRef<{ sceneId: Id; arrival: Arrival } | null>(
    null
  )
  const changeMap = async (
    req: ChangeMapRequest
  ): Promise<ChangeMapOutcome> => {
    // A save in flight would stamp the old map's library row on the new map (checked at confirm time).
    if (saveMap.saving)
      return "A restore point of this map is being saved. Try again in a moment."
    if (req.save && !(await saveMap.save({ quiet: true })))
      return "This map couldn't be saved to your library, so the table stayed here. See the notice for why."
    controller.cancel()
    editor?.ctx.controller.cancelGesture()
    // The editor's undo history belongs to this map: it goes before the swap (a new one follows).
    setSwapping(true)
    // The camera goes to the arrival as soon as the new map is in the engine.
    pendingFocus.current = { sceneId: req.scene.id, arrival: req.arrival }
    let r
    try {
      r = await runner.changeMap(req.scene, {
        tokenIds: req.tokenIds,
        arrival: req.arrival,
        origin: req.origin,
      })
    } finally {
      setSwapping(false)
    }
    if (!r.ok) {
      pendingFocus.current = null
      // Refused: the old map is still live, so its tokens name the ones left without room.
      const current = runner.getSnapshot().state?.scene.tokens ?? {}
      const names = r.unplaced.map((id) =>
        Object.hasOwn(current, id) ? tokenDisplayName(current[id]) : "a token"
      )
      return changeMapErrorText(r.error, names)
    }
    // Local choices that name the old map's tokens, areas and levels.
    setSelected(null)
    setTemplateId(null)
    setPreview(null)
    setLevelChoice(req.arrival.levelId)
    const n = Object.keys(r.carried).length
    toast.success(`Now at “${req.name}”`, {
      description:
        n === 0 ? "No tokens came along." : `${plural(n, "token")} came along.`,
    })
    void r.saved.then((saved) => {
      // After a stand-down the screen says why hosting stopped instead.
      if (saved || runner.getSnapshot().status !== "hosting") return
      toast.warning("The map change isn't saved yet", {
        description:
          "Atlas keeps trying in the background. If this tab closes before then, the previous map may come back.",
      })
    })
    return true
  }
  // Once the new map is in the engine (HostViewport's layout effect runs first), look at the arrival.
  React.useEffect(() => {
    const p = pendingFocus.current
    if (!p || !engine || scene.id !== p.sceneId) return
    pendingFocus.current = null
    if (!Object.hasOwn(scene.levels, p.arrival.levelId)) return
    const at = { x: p.arrival.x, z: p.arrival.z }
    engine.focus(
      { ...at, y: groundHeightAt(scene, p.arrival.levelId, at) },
      { distance: 60 }
    )
  }, [scene, engine])

  // Dev automation handles.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__atlasHost = {
      runner,
      engine,
      controller,
      editor,
      mode,
      setMode: switchMode,
    }
    if (editor)
      window.__atlasEditor = {
        store: editor.ctx.store,
        controller: editor.ctx.controller,
        engine,
      }
    return () => {
      if (window.__atlasHost?.runner === runner) delete window.__atlasHost
      if (editor && window.__atlasEditor?.store === editor.ctx.store)
        delete window.__atlasEditor
    }
  }, [runner, engine, controller, editor, mode, switchMode])

  // ---- page commands (menus, panels) -------------------------------------------------------------------
  const commands = React.useMemo<MapScreenCommands>(
    () => ({
      save: saveRestorePoint,
      newMap: (opts) => doc.newMap(opts),
      openMapImport: (levelId) => {
        if (!editing) switchMode("edit")
        setImportRequest({ mode: "existing", levelId: levelId ?? null })
      },
      openVersions: () => setVersionsOpen(true),
      exportFile: () => void doc.exportFile(),
      importFile: () => fileRef.current?.click(),
      openShare: () => setShareOpen(true),
      leave: () => go(paths.home()),
      openShortcuts: () => setKeysOpen(true),
    }),
    [saveRestorePoint, doc, editing, switchMode, go]
  )

  // ---- drag and drop: battlemaps onto the map (Edit), .atlas.json files anywhere ------------------------
  const [dropHint, setDropHint] = React.useState(false)
  const activeLevelName = editor
    ? (scene.levels[editor.ctx.store.getState().activeLevelId]?.name ??
      "the active level")
    : "the active level"
  const dropProps: React.HTMLAttributes<HTMLDivElement> = {
    onDragOver: (e) => {
      if (!hosting || !e.dataTransfer.types.includes("Files")) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      if (!dropHint) setDropHint(true)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        setDropHint(false)
    },
    onDrop: (e) => {
      if (!hosting) return
      e.preventDefault()
      setDropHint(false)
      const files = [...e.dataTransfer.files]
      const json = files.find((f) => /\.json$/i.test(f.name))
      if (json) return void doc.importFile(json)
      const images = files.filter(
        (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name)
      )
      if (images.length === 0)
        return void toast.error(
          "Drop battlemap images (PNG, JPEG, WebP) or an .atlas.json file"
        )
      if (!editor) return
      if (!editing) switchMode("edit")
      setImportRequest({
        mode: "existing",
        levelId: editor.ctx.store.getState().activeLevelId,
        files: images,
      })
    },
  }

  const main = (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <HostTopBar
        snap={snap}
        sceneName={scene.name}
        mode={mode}
        onMode={switchMode}
        menus={editor !== null}
        doc={doc}
        previewing={activePreview !== null}
        onPreview={togglePreview}
        sidebar={sidebar}
        onSidebar={setSidebar}
        onLeave={commands.leave}
        onChangeMap={() => setChanging(true)}
        savingMap={saveMap.saving}
        onOpenTable={openTable}
        onCloseTable={() => setClosingTable(true)}
      />
      <div className="flex min-h-0 flex-1">
        {editing ? <ToolRail /> : null}
        <main className="flex min-w-0 flex-1 flex-col">
          {editing ? <ToolOptionsBar /> : null}
          <div className="relative min-h-0 flex-1" {...dropProps}>
            {dropHint ? (
              <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary/60 bg-background/60 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-2 text-sm text-foreground">
                  <ImagePlus className="size-6 text-primary" />
                  Drop battlemaps to import them onto “{activeLevelName}”
                  <span className="text-xs text-muted-foreground">
                    …or an .atlas.json map file to add it to your library
                  </span>
                </div>
              </div>
            ) : null}
            <HostViewport
              key={quality.engineKey}
              quality={quality.quality}
              runner={runner}
              state={state}
              actions={actions}
              controller={controller}
              editor={editing ? editor : null}
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
              {editing ? (
                <div className="pointer-events-none absolute inset-0 z-10">
                  <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-3">
                    <LevelSwitcher />
                    {snap.tableOpen ? (
                      <HudPanel className="flex items-center gap-2 px-3 py-1.5 text-xs">
                        <span className="size-2 animate-pulse rounded-full bg-primary" />
                        The table is open: players see your changes as they
                        explore
                      </HudPanel>
                    ) : (
                      <span />
                    )}
                    <CameraControls />
                  </div>
                  <div className="absolute bottom-3 left-3">
                    <GettingStarted />
                  </div>
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
                          toast.success(`Rolled ${r.total} damage`, {
                            id: "area-damage",
                            description:
                              r.hit === 0
                                ? "No creature caught has tracked hit points."
                                : `Dealt to ${r.hit} ${r.hit === 1 ? "creature" : "creatures"}.`,
                          })
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
                        hosting ? null : "This tab isn't running the table."
                      }
                      focusSignal={chatFocus}
                    />
                  </div>
                </div>
              )}
              {!editing ? (
                <TokenBadges
                  tokens={badges}
                  showOn={(levelId) =>
                    levelShown(scene, activeLevelId, levelId)
                  }
                />
              ) : null}
              {!editing &&
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
                enabled={!editing}
              />
            </HostViewport>
            {snap.status === "ended" ? <TableEnded /> : null}
          </div>
        </main>
        {sidebar ? (
          editing ? (
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
              onOpenTable={openTable}
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
      <CloseTableDialog
        open={closingTable}
        onOpenChange={setClosingTable}
        players={playersAtTable}
        onClose={closeTable}
      />
      <LeaveTableDialog
        open={leaveTo !== null}
        onOpenChange={(o) => {
          if (!o) setLeaveTo(null)
        }}
        players={playersAtTable}
        onLeave={(choice) =>
          leaveTo ? leaveNow(leaveTo, choice) : Promise.resolve(true)
        }
      />
      <ChangeMapDialog
        open={changing && hosting}
        onOpenChange={setChanging}
        state={state}
        currentSceneId={snap.library?.sceneId ?? null}
        saveMap={saveMap}
        onChange={changeMap}
      />
      <VersionHistorySheet
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        doc={doc}
      />
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} doc={doc} />
      {editor ? (
        <MapImportDialog
          request={importRequest}
          onClose={() => setImportRequest(null)}
          doc={doc}
        />
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept=".json,.atlas.json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (file) void doc.importFile(file)
        }}
      />
      <HostStatusBar
        snap={snap}
        frame={frame}
        quality={quality.choice}
        onQuality={quality.setChoice}
        edit={
          editing && editor ? (
            <EditStatusItems cursor={editor.cursor} />
          ) : undefined
        }
      />
    </div>
  )

  // The providers are always present (null until the editor exists) so switching modes never remounts the map.
  // The inspector's asset pickers offer what this game loads (GameState.freeAssets).
  return (
    <FreeAssetScopeContext.Provider value={freeAssetScope}>
      <EditorContext.Provider value={editor ? editor.ctx : null}>
        <HostEditorProviders
          editor={editor}
          engine={engine}
          commands={commands}
        >
          {main}
        </HostEditorProviders>
      </EditorContext.Provider>
    </FreeAssetScopeContext.Provider>
  )
}
