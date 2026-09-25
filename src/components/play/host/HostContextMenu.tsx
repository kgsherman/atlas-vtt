/**
 * Right-click menus on the DM's live scene: tokens (select, preview vision, hide/reveal, add to or remove
 * from combat, move to level, its world character or the players controlling it, conditions), doors
 * (open/close/lock/unlock, reveal a secret door) and lights (on/off).
 */
import {
  Dices,
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
  Tags,
  UserPlus,
  UserRoundPlus,
  UsersRound,
} from "lucide-react"

import {
  useCharacterLinks,
  type CharacterLinks,
} from "@/components/editor/context"

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
import { CONDITION_LABELS, TOKEN_CONDITIONS } from "@/core/scene/tokenStatus"
import type { Id } from "@/core/scene/types"
import type { GameState } from "@/core/session/types"
import { tokenDisplayName } from "@/play"

import { CONDITION_ICONS } from "../table/healthStyle"
import type { HostActions } from "./hostActions"
import type { MenuTarget } from "./menuTarget"
import { playerLabels } from "./playerLabels"

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
  // The world's characters (ARCHITECTURE §6.9); null: the table knows no roster.
  const links = useCharacterLinks()
  const scene = state.scene
  const labels = playerLabels(Object.values(state.players))
  const players = Object.values(state.players)
    .map((p) => ({ ...p, displayName: labels.get(p.userId) ?? p.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  if (target.kind === "token") {
    const t = Object.hasOwn(scene.tokens, target.id)
      ? scene.tokens[target.id]
      : null
    if (!t) return null
    const owners = state.owners[t.id] ?? []
    const inCombat =
      state.table?.combat?.entries.some((e) => e.tokenId === t.id) ?? false
    const conditions = new Set(t.conditions ?? [])
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
          {inCombat ? (
            <ContextMenuItem
              onClick={() => actions.removeFromCombat({ tokenId: t.id })}
            >
              <Dices /> Remove from combat
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={() => actions.addToCombat([t.id])}>
              <Dices />{" "}
              {state.table?.combat ? "Add to combat" : "Start combat with it"}
            </ContextMenuItem>
          )}
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
        {links ? (
          <CharacterSubmenu
            tokenId={t.id}
            characterId={t.characterId ?? null}
            links={links}
          />
        ) : null}
        {links && t.characterId ? null : (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <UserPlus /> Controlled by
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              {/* Base UI labels throw outside a group (and crash the host console). */}
              <ContextMenuGroup>
                {players.length === 0 ? (
                  <ContextMenuLabel>
                    No players have joined yet
                  </ContextMenuLabel>
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
              </ContextMenuGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tags /> Conditions
            {conditions.size > 0 ? (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {conditions.size}
              </span>
            ) : null}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-48">
            <ContextMenuGroup>
              {TOKEN_CONDITIONS.map((c) => {
                const Icon = CONDITION_ICONS[c]
                return (
                  <ContextMenuCheckboxItem
                    key={c}
                    checked={conditions.has(c)}
                    closeOnClick={false}
                    onCheckedChange={(on) =>
                      actions.changeTokenStatus(t.id, {
                        conditions: on ? { add: [c] } : { remove: [c] },
                      })
                    }
                  >
                    <Icon /> {CONDITION_LABELS[c]}
                  </ContextMenuCheckboxItem>
                )
              })}
            </ContextMenuGroup>
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
      <ContextMenuGroup>
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
      </ContextMenuGroup>
    </ContextMenuContent>
  )
}

/** The token's world character: who plays it, another one, none, or a new one made from the token. */
function CharacterSubmenu({
  tokenId,
  characterId,
  links,
}: {
  tokenId: Id
  characterId: Id | null
  links: CharacterLinks
}) {
  const linked = characterId
    ? links.characters.find((c) => c.id === characterId)
    : undefined
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <UsersRound />{" "}
        {linked
          ? `Character: ${linked.name}`
          : characterId
            ? "Character: deleted"
            : "Character"}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-80 w-56">
        {linked ? (
          <ContextMenuGroup>
            <ContextMenuLabel className="font-normal text-muted-foreground">
              {linked.players.length > 0
                ? `Played by ${linked.players.map(links.playerName).join(", ")}`
                : "Nobody plays this character yet"}
            </ContextMenuLabel>
          </ContextMenuGroup>
        ) : null}
        <ContextMenuGroup>
          <ContextMenuItem onClick={links.openRoster}>
            <UsersRound /> Who plays whom…
          </ContextMenuItem>
          {characterId ? null : (
            <ContextMenuItem onClick={() => void links.makeCharacter(tokenId)}>
              <UserRoundPlus /> Make it a character
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        {links.characters.length > 0 || characterId ? (
          <ContextMenuSeparator />
        ) : null}
        <ContextMenuGroup>
          {links.characters.length > 0 ? (
            <ContextMenuLabel>This token is</ContextMenuLabel>
          ) : null}
          {links.characters.map((c) => (
            <ContextMenuCheckboxItem
              key={c.id}
              checked={c.id === characterId}
              onCheckedChange={(on) => links.link(tokenId, on ? c.id : null)}
            >
              {c.name}
            </ContextMenuCheckboxItem>
          ))}
          {characterId ? (
            <ContextMenuItem onClick={() => links.link(tokenId, null)}>
              Not a character
            </ContextMenuItem>
          ) : null}
        </ContextMenuGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
