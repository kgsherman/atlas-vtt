/**
 * Keyboard shortcuts: every editor / play command with its keys, rebindable. Clicking a key (or "+")
 * records a new one with TanStack Hotkeys' recorder (which pauses the app's hotkeys meanwhile); a key
 * taken from another command moves. Remaps are saved per browser (keymapStore).
 */
import { areHotkeysEqual, parseHotkey, useHotkeyRecorder, type Hotkey } from "@tanstack/react-hotkeys"
import { Plus, RotateCcw, TriangleAlert, X } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EDITOR_COMMAND_GROUPS, EDITOR_POINTER_HELP, isEditorCameraKey } from "@/editor/shortcuts"
import { hotkeyLabel, hotkeyParts } from "@/lib/hotkeys"
import { assignKey, commandUsing, conflictsOf, keysOf, removeKey, resetCommand, type Command } from "@/lib/keymap"
import { cn } from "@/lib/utils"
import { PLAY_POINTER_HELP, playCommandsFor } from "@/play"

import { KEYMAPS, keymapStore, setKeyOverrides, useKeyOverrides, type KeymapScope } from "./keymapStore"

const SCOPE_LABELS: Record<KeymapScope, string> = { editor: "Edit", play: "Play" }

/** Keys a command may hold at once. */
const MAX_KEYS = 3

/** Browsers act on these before the page sees them. */
const RESERVED: Hotkey[] = ["Mod+W", "Mod+T", "Mod+N", "Mod+Q", "Mod+Shift+T", "Mod+Shift+N", "Mod+Shift+W", "Mod+Tab", "Mod+Shift+Tab"]

/** Play's camera pans on these (by position, Shift included) whatever the keymap says. */
const CAMERA_KEYS = ["W", "A", "S", "D", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]

interface HelpRow {
  keys: string
  label: string
}

function commandsFor(scope: KeymapScope, host: boolean): Command[] {
  return scope === "play" ? playCommandsFor(host) : KEYMAPS.editor
}

function groupsFor(scope: KeymapScope, host: boolean): { title: string; commands: Command[] }[] {
  if (scope === "play") return [{ title: "Keys", commands: commandsFor("play", host) }]
  return EDITOR_COMMAND_GROUPS.map((group) => ({ title: group, commands: KEYMAPS.editor.filter((c) => c.group === group) }))
}

/** "Drag an arrow (terrain, advanced)": the context in parentheses names the tool / mode a gesture belongs to. */
const TERRAIN_CONTEXT = /\s*\(terrain(?:,\s*([^)]+))?\)$/

/**
 * Mouse and held-key rows as titled sections: the terrain mode's gestures get their own (context moved from
 * the keys to the label, so the key caps stay short).
 */
function helpFor(scope: KeymapScope, host: boolean): { title: string; rows: HelpRow[] }[] {
  if (scope === "play") return [{ title: "Mouse & held keys", rows: PLAY_POINTER_HELP.filter((h) => host || !h.hostOnly) }]
  const general: HelpRow[] = []
  const terrain: HelpRow[] = []
  for (const h of EDITOR_POINTER_HELP) {
    const m = TERRAIN_CONTEXT.exec(h.keys)
    if (!m) general.push(h)
    else terrain.push({ keys: h.keys.slice(0, m.index), label: m[1] ? `${h.label} (${m[1]})` : h.label })
  }
  return [
    { title: "Mouse & held keys", rows: general },
    { title: "Terrain mouse", rows: terrain },
  ].filter((g) => g.rows.length > 0)
}

/** Why `hotkey` can't be bound here, or null. */
function rejectReason(scope: KeymapScope, hotkey: Hotkey): string | null {
  if (RESERVED.some((r) => areHotkeysEqual(r, hotkey))) return `The browser keeps ${hotkeyLabel(hotkey)} for itself.`
  const parsed = parseHotkey(hotkey)
  const plain = !parsed.ctrl && !parsed.alt && !parsed.meta
  if (scope === "play" && plain && parsed.key !== undefined && CAMERA_KEYS.includes(parsed.key)) return `${hotkeyLabel(hotkey)} pans the camera in play.`
  if (scope === "editor" && isEditorCameraKey(hotkey)) return `${hotkeyLabel(hotkey)} pans the camera in the editor.`
  return null
}

export interface KeybindingsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Keymaps to show as tabs, first selected. */
  scopes: KeymapScope[]
  /** Include the DM-only play commands. */
  host?: boolean
}

export function KeybindingsDialog({ open, onOpenChange, scopes, host = false }: KeybindingsDialogProps) {
  const [scope, setScope] = React.useState<KeymapScope>(scopes[0])
  const [target, setTarget] = React.useState<{ id: string; slot: number } | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const overrides = useKeyOverrides(scope)
  const commands = KEYMAPS[scope] as readonly Command[]
  const labelOf = (id: string) => commands.find((c) => c.id === id)?.label ?? id

  const recorder = useHotkeyRecorder({
    recordBy: "key",
    validate: (hotkey) => rejectReason(scope, hotkey) ?? true,
    onReject: (r) => setNotice(r.message),
    onRecord: (hotkey) => {
      setTarget(null)
      if (!target) return
      const current = keymapStore.getState()[scope]
      const previous = commandUsing(commands, current, hotkey, target.id)
      setKeyOverrides(scope, assignKey(commands, current, target.id, hotkey, target.slot))
      setNotice(previous ? `${hotkeyLabel(hotkey)} moved here from “${previous.label}”.` : null)
    },
    onClear: () => {
      setTarget(null)
      if (!target) return
      const current = keymapStore.getState()[scope]
      setKeyOverrides(scope, removeKey(commands, current, target.id, target.slot))
    },
    onCancel: () => setTarget(null),
  })

  const record = (id: string, slot: number) => {
    recorder.cancelRecording()
    setNotice(null)
    setTarget({ id, slot })
    recorder.startRecording()
  }
  const stop = () => {
    recorder.cancelRecording()
    setNotice(null)
  }

  const conflicted = new Set(conflictsOf(commands, overrides).flatMap((c) => c.ids))
  const help = helpFor(scope, host)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) stop()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Click a key to change it, or + to add another. While recording, Esc cancels and Backspace removes the key. Shortcuts don't fire while typing in a
            text field.
          </DialogDescription>
        </DialogHeader>
        {scopes.length > 1 ? (
          <Tabs
            value={scope}
            onValueChange={(v) => {
              stop()
              setScope(v as KeymapScope)
            }}
          >
            <TabsList>
              {scopes.map((s) => (
                <TabsTrigger key={s} value={s}>
                  {SCOPE_LABELS[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        <ScrollArea className="max-h-[55vh]">
          <div className="grid gap-x-6 gap-y-5 pr-3 sm:grid-cols-2">
            {groupsFor(scope, host).map((g) => (
              <section key={g.title} className="flex flex-col gap-1">
                <h3 className="px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">{g.title}</h3>
                <div className="flex flex-col">
                  {g.commands.map((c) => (
                    <CommandRow
                      key={c.id}
                      command={c}
                      keys={keysOf(c, overrides)}
                      overridden={Object.hasOwn(overrides, c.id)}
                      conflicted={conflicted.has(c.id)}
                      recordingSlot={target?.id === c.id && recorder.isRecording ? target.slot : null}
                      onRecord={(slot) => record(c.id, slot)}
                      onRemove={(slot) => setKeyOverrides(scope, removeKey(commands, overrides, c.id, slot))}
                      onReset={() => setKeyOverrides(scope, resetCommand(commands, overrides, c.id))}
                    />
                  ))}
                </div>
              </section>
            ))}
            {help.map((g) => (
              <section key={g.title} className="flex flex-col gap-1">
                <h3 className="px-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">{g.title}</h3>
                <div className="flex flex-col">
                  {g.rows.map((h) => (
                    <div key={h.keys + h.label} className="flex min-h-7 items-center justify-between gap-4 px-1 text-xs">
                      <span className="text-foreground/85">{h.label}</span>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {h.keys.split(" / ").map((k, i) => (
                          <React.Fragment key={k}>
                            {i > 0 ? <span className="text-[0.625rem] text-muted-foreground">or</span> : null}
                            <Kbd className="whitespace-nowrap">{k}</Kbd>
                          </React.Fragment>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter className="items-center sm:justify-between">
          <p role="status" aria-live="polite" className="min-h-4 text-muted-foreground">
            {notice ?? (target && recorder.isRecording ? `Press the new key for “${labelOf(target.id)}”…` : "")}
          </p>
          <Button
            variant="outline"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => {
              stop()
              setKeyOverrides(scope, {})
            }}
          >
            <RotateCcw data-icon="inline-start" />
            Reset all {SCOPE_LABELS[scope].toLowerCase()} keys
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CommandRowProps {
  command: Command
  keys: readonly Hotkey[]
  overridden: boolean
  conflicted: boolean
  /** Key slot being recorded (keys.length = a new key), or null. */
  recordingSlot: number | null
  onRecord(slot: number): void
  onRemove(slot: number): void
  onReset(): void
}

function CommandRow({ command, keys, overridden, conflicted, recordingSlot, onRecord, onRemove, onReset }: CommandRowProps) {
  const adding = recordingSlot !== null && recordingSlot >= keys.length
  return (
    <div className="group/row flex min-h-7 items-center justify-between gap-3 rounded-md px-1 py-0.5 text-xs hover:bg-muted/40">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground/85">
        {command.label}
        {conflicted ? (
          <Tooltip>
            <TooltipTrigger render={<TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-label="Key conflict" />} />
            <TooltipContent>Shares a key with another command</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-1">
        {keys.map((k, slot) => (
          <span key={k} className="flex items-center">
            <KeyButton hotkey={k} recording={recordingSlot === slot} onClick={() => onRecord(slot)} />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${hotkeyLabel(k)} from ${command.label}`}
              className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
              onClick={() => onRemove(slot)}
            >
              <X />
            </Button>
          </span>
        ))}
        {keys.length === 0 && !adding ? <span className="text-muted-foreground">Unbound</span> : null}
        {adding ? <KeyButton recording onClick={() => onRecord(keys.length)} /> : null}
        {!adding && keys.length < MAX_KEYS ? (
          <Button variant="ghost" size="icon-xs" aria-label={`Add a key for ${command.label}`} onClick={() => onRecord(keys.length)}>
            <Plus />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Reset ${command.label} to its default keys`}
          className={cn(!overridden && "invisible")}
          onClick={onReset}
        >
          <RotateCcw />
        </Button>
      </span>
    </div>
  )
}

function KeyButton({ hotkey, recording, onClick }: { hotkey?: Hotkey; recording: boolean; onClick(): void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-label={recording ? "Recording: press a key" : `Change ${hotkey ? hotkeyLabel(hotkey) : "key"}`}
      aria-pressed={recording}
      className={cn("h-6 px-1", recording && "animate-pulse border-primary text-primary")}
      onClick={onClick}
    >
      {recording || !hotkey ? (
        <span className="px-1">Press keys…</span>
      ) : (
        <KbdGroup>
          {hotkeyParts(hotkey).map((p, i) => (
            <Kbd key={i}>{p}</Kbd>
          ))}
        </KbdGroup>
      )}
    </Button>
  )
}
