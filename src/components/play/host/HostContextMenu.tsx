/**
 * Right-click menus on the DM's live map: tokens (select, preview vision, hide/reveal, move to level,
 * assign to players), doors (open/close/lock/unlock, reveal a secret door) and lights (on/off).
 */
import {
  DoorClosed,
  DoorOpen,
  Eye,
  EyeOff,
  Flame,
  KeyRound,
  Layers,
  Lock,
  LockOpen,
  MousePointerClick,
  ScanEye,
  Sparkles,
  UserPlus,
} from "lucide-react"

import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import { sortedLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { tokenDisplayName } from "@/play"

import type { HostActions } from "./hostActions"
import type { MenuTarget } from "./menuTarget"

export function HostContextMenuContent({
  target,
  state,
  actions,
  onPreview,
  onSelect,
}: {
  target: MenuTarget
  state: GameState
  actions: HostActions
  onPreview(tokenId: Id): void
  onSelect(tokenId: Id): void
}) {
  const scene = state.scene
  const players = Object.values(state.players).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  )

  if (target.kind === "token") {
    const t = Object.hasOwn(scene.tokens, target.id)
      ? scene.tokens[target.id]
      : null
    if (!t) return null
    const owners = state.owners[t.id] ?? []
    return (
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate">
            {tokenDisplayName(t)}
          </ContextMenuLabel>
          <ContextMenuItem onClick={() => onSelect(t.id)}>
            <MousePointerClick /> Select
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onPreview(t.id)}>
            <ScanEye /> Preview its vision
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => actions.setTokensHidden([t.id], !t.hidden)}
          >
            {t.hidden ? <Eye /> : <EyeOff />}{" "}
            {t.hidden ? "Reveal to players" : "Hide from players"}
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Layers /> Move to level
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {sortedLevels(scene)
              .reverse()
              .map((l) => (
                <ContextMenuCheckboxItem
                  key={l.id}
                  checked={l.id === t.levelId}
                  disabled={l.id === t.levelId}
                  onClick={() => actions.moveTokenToLevel(t.id, l.id)}
                >
                  {l.name}
                </ContextMenuCheckboxItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <UserPlus /> Controlled by
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            {players.length === 0 ? (
              <ContextMenuLabel>No players have joined yet</ContextMenuLabel>
            ) : null}
            {players.map((p) => (
              <ContextMenuCheckboxItem
                key={p.userId}
                checked={owners.includes(p.userId)}
                onCheckedChange={(checked) =>
                  actions.assign(t.id, p.userId, checked)
                }
                closeOnClick={false}
              >
                {p.displayName}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    )
  }

  if (target.kind === "door") {
    const d = Object.hasOwn(scene.objects, target.id)
      ? scene.objects[target.id]
      : null
    if (!d || d.type !== "door") return null
    const secret = d.style === "secret"
    return (
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate">
            {d.name || (secret ? "Secret door" : "Door")} · {d.state}
          </ContextMenuLabel>
          {d.state === "open" ? (
            <ContextMenuItem onClick={() => actions.setDoor(d.id, "closed")}>
              <DoorClosed /> Close
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={() => actions.setDoor(d.id, "open")}>
              <DoorOpen /> Open{d.state === "locked" ? " (unlocks it)" : ""}
            </ContextMenuItem>
          )}
          {d.state === "locked" ? (
            <ContextMenuItem onClick={() => actions.setDoor(d.id, "closed")}>
              <LockOpen /> Unlock
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={() => actions.setDoor(d.id, "locked")}>
              <Lock /> Close and lock
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        {secret ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => actions.revealDoor(d.id)}>
              <Sparkles /> Reveal to every player
            </ContextMenuItem>
            {players.length > 0 ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <KeyRound /> Reveal to…
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {players.map((p) => {
                    const known = (state.revealed[p.userId] ?? []).includes(
                      d.id
                    )
                    return (
                      <ContextMenuCheckboxItem
                        key={p.userId}
                        checked={known}
                        disabled={known}
                        onClick={() => actions.revealDoor(d.id, p.userId)}
                      >
                        {p.displayName}
                      </ContextMenuCheckboxItem>
                    )
                  })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
          </>
        ) : null}
      </ContextMenuContent>
    )
  }

  const l = Object.hasOwn(scene.objects, target.id)
    ? scene.objects[target.id]
    : null
  if (!l || l.type !== "light") return null
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuLabel className="truncate">
        {l.name || "Light"}
      </ContextMenuLabel>
      <ContextMenuItem onClick={() => actions.setLight(l.id, !l.on)}>
        <Flame /> {l.on ? "Put out" : "Light it"}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => actions.setObjectsHidden([l.id], !l.hidden)}
      >
        {l.hidden ? <Eye /> : <EyeOff />}{" "}
        {l.hidden ? "Reveal to players" : "Hide from players"}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
