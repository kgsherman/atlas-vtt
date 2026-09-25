/**
 * The table's chat and dice dock (DM and players): a toggle with an unread count at the bottom-right,
 * and above it a panel with the log (chat, whispers, roll cards, notices), quick dice, who hears it and
 * the input box (chat, /r rolls, /gr private rolls, /w whispers, or a bare formula like 2d6+3). While
 * closed, the newest message from someone else shows briefly above the toggle.
 */
import * as React from "react"
import { Crown, EyeOff, MessageSquare, SendHorizontal, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { glass, HudButton, HudPanel } from "../hud"
import { isBool, usePreference } from "../useSessionResource"
import {
  formatTime,
  parseChatInput,
  resolveAudience,
  type Audience,
  type AudienceOption,
  type ChatEntry,
} from "./chatModel"
import { RollCard } from "./RollCard"

const QUICK_DICE: { label: string; formula: string; title: string }[] = [
  { label: "d4", formula: "1d4", title: "Roll a d4" },
  { label: "d6", formula: "1d6", title: "Roll a d6" },
  { label: "d8", formula: "1d8", title: "Roll a d8" },
  { label: "d10", formula: "1d10", title: "Roll a d10" },
  { label: "d12", formula: "1d12", title: "Roll a d12" },
  { label: "d20", formula: "1d20", title: "Roll a d20" },
  { label: "d%", formula: "1d100", title: "Roll percentile dice" },
  {
    label: "Adv",
    formula: "adv",
    title: "d20 with advantage (2d20, keep the higher)",
  },
  {
    label: "Dis",
    formula: "dis",
    title: "d20 with disadvantage (2d20, keep the lower)",
  },
]

/** Up to this many messages the panel is as tall as its log; beyond, it has a fixed height and scrolls. */
const COMPACT_ENTRIES = 4

/** How long the newest message shows above the closed dock (ms). */
const PREVIEW_MS = 6000

export interface ChatDockProps {
  entries: ChatEntry[]
  role: "player" | "dm"
  audiences: AudienceOption[]
  /** Players the DM may whisper to by name (/w name text). */
  players?: readonly { userId: string; name: string }[]
  onSay(text: string, audience: Audience): void
  onRoll(formula: string, audience: Audience): void
  /** Why nothing can be sent right now (offline, DM away…); null: go ahead. */
  disabledReason?: string | null
  /** localStorage key prefix for the open state. */
  storageKey: string
  /** Open requests from outside (the Enter shortcut): bump to open and focus the input. */
  focusSignal?: number
}

export function ChatDock({
  entries,
  role,
  audiences,
  players = [],
  onSay,
  onRoll,
  disabledReason = null,
  storageKey,
  focusSignal = 0,
}: ChatDockProps) {
  const [open, setOpen] = usePreference(`${storageKey}:open`, false, isBool)
  const [audienceKeyValue, setAudienceKey] = usePreference(
    `${storageKey}:audience`,
    "all",
    (v): v is string => typeof v === "string"
  )
  const option = resolveAudience(audiences, audienceKeyValue)
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const logRef = React.useRef<HTMLDivElement>(null)

  // ---- unread + preview ------------------------------------------------------------------------
  const newest = entries.at(-1) ?? null
  const newestAt = newest?.at ?? 0
  // Read: what was there when the dock mounted, and everything up to the last time it was closed.
  const [seenAt, setSeenAt] = React.useState(newestAt)
  const unread = open
    ? 0
    : entries.filter((e) => e.at > seenAt && !e.mine).length
  // The newest message from someone else shows above the closed dock for PREVIEW_MS.
  const [previewDoneAt, setPreviewDoneAt] = React.useState(newestAt)
  const preview =
    !open && newest && !newest.mine && newest.at > previewDoneAt ? newest : null
  const previewAt = preview?.at ?? null
  React.useEffect(() => {
    if (previewAt === null) return
    const t = setTimeout(() => setPreviewDoneAt(previewAt), PREVIEW_MS)
    return () => clearTimeout(t)
  }, [previewAt])
  const toggle = (next: boolean) => {
    if (!next) {
      setSeenAt(newestAt)
      setPreviewDoneAt(newestAt)
    }
    setOpen(next)
  }

  // ---- open / focus -------------------------------------------------------------------------------
  // Only new requests: a dock mounted again (e.g. after the DM's Edit ↔ Play switch) must not reopen itself.
  const handledSignal = React.useRef(focusSignal)
  React.useEffect(() => {
    if (focusSignal === handledSignal.current) return
    handledSignal.current = focusSignal
    setOpen(true)
    // After the panel mounts.
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [focusSignal, setOpen])
  // Follow the newest message (the viewport scrolls, never the page or the panel).
  React.useEffect(() => {
    if (!open) return
    const viewport = logRef.current?.closest<HTMLElement>(
      "[data-slot=scroll-area-viewport]"
    )
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [open, newest?.id])

  // ---- sending --------------------------------------------------------------------------------------
  const send = (cmd: ReturnType<typeof parseChatInput>) => {
    if (cmd.kind === "none") return false
    if (cmd.kind === "error") {
      setError(cmd.message)
      return false
    }
    if (disabledReason) {
      setError(disabledReason)
      return false
    }
    setError(null)
    if (cmd.kind === "say") onSay(cmd.text, cmd.audience)
    else onRoll(cmd.formula, cmd.audience)
    return true
  }
  const submit = () => {
    if (send(parseChatInput(draft, role, option.audience, players)))
      setDraft("")
  }
  const quickRoll = (formula: string) =>
    send({ kind: "roll", formula, audience: option.audience })

  const privateAudience = option.audience.kind !== "all"

  return (
    <div className="pointer-events-none relative">
      {open ? (
        <HudPanel
          className={cn(
            "absolute right-0 bottom-full mb-2 flex w-[22rem] flex-col overflow-hidden",
            // A few messages: as tall as they are. More: a fixed height, so the log scrolls.
            entries.length > COMPACT_ENTRIES &&
              "h-[min(34rem,calc(100svh-9rem))]"
          )}
          onPointerDown={(e) => e.stopPropagation()}
          role="region"
          aria-label="Chat and dice"
        >
          <div className="flex shrink-0 items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
            <MessageSquare className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-medium">Chat & dice</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close chat"
              onClick={() => toggle(false)}
            >
              <X />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1 basis-auto">
            <div
              ref={logRef}
              className="flex flex-col gap-2 px-3 py-2"
              role="log"
              aria-live="polite"
            >
              {entries.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Nothing said yet. Roll with the dice below, or type
                  <br />
                  <span className="font-mono">/r 1d20+5 to hit</span>
                </p>
              ) : (
                entries.map((e) => (
                  <ChatLine
                    key={e.id}
                    entry={e}
                    onReroll={(f) => quickRoll(f)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
          <div className="flex shrink-0 flex-col gap-1.5 border-t p-2">
            <div className="flex flex-wrap gap-0.5" aria-label="Quick dice">
              {QUICK_DICE.map((d) => (
                <Tooltip key={d.label}>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 min-w-8 px-1.5 font-mono text-[0.6875rem]"
                        aria-label={d.title}
                        onClick={() => quickRoll(d.formula)}
                      />
                    }
                  >
                    {d.label}
                  </TooltipTrigger>
                  <TooltipContent side="top">{d.title}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <InputGroup
              className={cn(
                privateAudience &&
                  "border-sidebar-primary/50 dark:border-sidebar-primary/50"
              )}
            >
              <InputGroupAddon align="inline-start" className="pl-1">
                <Select
                  value={option.key}
                  onValueChange={(v) => v && setAudienceKey(v as string)}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-5 max-w-28 gap-1 border-0 bg-transparent px-1.5 text-[0.6875rem] shadow-none dark:bg-transparent"
                    aria-label="Who hears it"
                  >
                    <SelectValue>
                      {() => (
                        <span className="flex items-center gap-1 truncate">
                          {privateAudience ? (
                            <EyeOff className="size-3 text-sidebar-primary" />
                          ) : null}
                          {option.audience.kind === "all"
                            ? "All"
                            : option.audience.kind === "dm"
                              ? "DM"
                              : option.audience.kind === "self"
                                ? "Me"
                                : option.label.replace(/^Whisper to /, "")}
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {audiences.map((a) => (
                      <SelectItem key={a.key} value={a.key} className="text-xs">
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InputGroupAddon>
              <InputGroupInput
                ref={inputRef}
                value={draft}
                placeholder={
                  privateAudience
                    ? "Whisper, or /r 1d20…"
                    : "Say something, or /r 1d20…"
                }
                aria-label="Message"
                maxLength={600}
                onChange={(e) => {
                  setDraft(e.target.value)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  // Keep map shortcuts (WASD, Q/E, M…) out of the text box.
                  e.stopPropagation()
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    if (draft) setDraft("")
                    else {
                      inputRef.current?.blur()
                      toggle(false)
                    }
                  }
                }}
                onKeyUp={(e) => e.stopPropagation()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Send"
                  onClick={submit}
                  disabled={!draft.trim()}
                >
                  <SendHorizontal />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error || disabledReason ? (
              <p
                className="px-1 text-[0.6875rem] text-destructive"
                role="alert"
              >
                {error ?? disabledReason}
              </p>
            ) : null}
          </div>
        </HudPanel>
      ) : preview ? (
        <Button
          variant="ghost"
          className={cn(
            "pointer-events-auto absolute right-0 bottom-full mb-2 block h-auto w-72 animate-in rounded-lg p-2.5 text-left text-xs font-normal whitespace-normal fade-in slide-in-from-bottom-1",
            glass
          )}
          onClick={() => toggle(true)}
          aria-label="Open chat"
        >
          <ChatLine entry={preview} compact />
        </Button>
      ) : null}
      <HudPanel className="relative p-1">
        <HudButton
          label={open ? "Hide chat & dice" : "Chat & dice"}
          shortcut="Enter"
          icon={<MessageSquare />}
          active={open}
          onClick={() => toggle(!open)}
        />
        {unread > 0 ? (
          <Badge
            className="pointer-events-none absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 tabular-nums"
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
      </HudPanel>
    </div>
  )
}

function ChatLine({
  entry: e,
  onReroll,
  compact,
}: {
  entry: ChatEntry
  onReroll?: (formula: string) => void
  compact?: boolean
}) {
  if (e.kind === "system") {
    return (
      <div
        className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground"
        data-kind="system"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="font-medium">{e.text}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  return (
    <div
      className={cn(
        "flex flex-col text-xs",
        e.whisper &&
          "rounded-md bg-sidebar-primary/5 px-2 py-1 ring-1 ring-sidebar-primary/25"
      )}
      data-kind={e.kind}
      data-whisper={e.whisper || undefined}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="size-2 shrink-0 translate-y-px rounded-full"
          style={{ backgroundColor: e.color }}
          aria-hidden
        />
        <span className="truncate font-medium">{e.name}</span>
        {e.fromDm ? (
          // The host sets this; a player named "DM" gets no crown.
          <Crown
            className="size-3 shrink-0 translate-y-0.5 text-sidebar-primary"
            aria-label="(the DM)"
          />
        ) : null}
        {e.privacy ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[0.625rem] text-sidebar-primary">
            <EyeOff className="size-2.5" /> {e.privacy}
          </span>
        ) : null}
        {e.kind === "roll" && e.text ? (
          <span className="truncate text-muted-foreground">· {e.text}</span>
        ) : null}
        {compact ? null : (
          <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground tabular-nums">
            {formatTime(e.at)}
          </span>
        )}
      </div>
      {e.kind === "roll" && e.roll ? (
        <RollCard roll={e.roll} onReroll={compact ? undefined : onReroll} />
      ) : (
        <p className="pl-3.5 break-words whitespace-pre-wrap">{e.text}</p>
      )}
    </div>
  )
}
