/**
 * A world's characters and who plays each (ARCHITECTURE §6.9): the one place the DM hands characters to
 * players, for every scene of the world. On the world page and, as a dialog, at the table.
 */
import * as React from "react"
import { EllipsisIcon, PencilLineIcon, PlusIcon, Trash2Icon, UserPlusIcon, UsersIcon } from "lucide-react"

import { useConfirm } from "@/components/editor/context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { MAX_PLAYERS_PER_CHARACTER, type WorldCharacter } from "@/net/worldsRepo"

import { CharacterDialog, type CharacterDialogTarget } from "./CharacterDialog"
import { CharacterAvatar } from "./CharacterAvatar"
import type { RosterActions, WorldRoster } from "./roster"

export function WorldCharacters({ roster, actions, className }: { roster: WorldRoster; actions: RosterActions; className?: string }) {
  const confirm = useConfirm()
  const [dialog, setDialog] = React.useState<CharacterDialogTarget | null>(null)
  const players = roster.members.filter((m) => m.status === "active")
  const nameOf = (uid: string) => roster.members.find((m) => m.userId === uid)?.displayName ?? "A player who left"

  const save = async (input: Parameters<RosterActions["createCharacter"]>[0], target: CharacterDialogTarget) => {
    if (target.kind === "new") return (await actions.createCharacter(input)) !== null
    return actions.updateCharacter(target.character.id, input)
  }

  const remove = async (c: WorldCharacter) => {
    const ok = await confirm({
      title: `Delete ${c.name}?`,
      description: "Tokens linked to the character stay in their scenes, but nobody controls them any more. This can't be undone.",
      confirmLabel: "Delete character",
      destructive: true,
    })
    if (ok) await actions.removeCharacter(c.id)
  }

  return (
    <div className={className}>
      {roster.characters.length === 0 ? (
        <Empty className="border border-dashed py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No characters yet</EmptyTitle>
            <EmptyDescription>
              Add your players' characters here and choose who plays each. Link a token to a character in any scene of the world, and its player controls it.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setDialog({ kind: "new" })}>
              <PlusIcon data-icon="inline-start" />
              New character
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {players.length === 0
                ? "No players have joined yet: share the room code, then choose who plays whom."
                : "Who plays each character, in every scene of the world."}
            </p>
            <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "new" })}>
              <PlusIcon data-icon="inline-start" />
              New character
            </Button>
          </div>
          <ItemGroup className="gap-2">
            {roster.characters.map((c) => (
              <Item key={c.id} variant="outline" className="bg-card/60">
                <ItemMedia>
                  <CharacterAvatar character={c} />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="truncate">{c.name}</ItemTitle>
                  <ItemDescription className="flex flex-wrap items-center gap-1">
                    {c.playerIds.length === 0 ? (
                      <span>Nobody plays them yet</span>
                    ) : (
                      c.playerIds.map((uid) => (
                        <Badge key={uid} variant="secondary" className="h-5">
                          {nameOf(uid)}
                        </Badge>
                      ))
                    )}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="gap-1">
                  <PlayedByMenu character={c} players={players} onToggle={(uid, plays) => void actions.togglePlayer(c, uid, plays)} />
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${c.name}`} />}>
                      <EllipsisIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => setDialog({ kind: "edit", character: c })}>
                        <PencilLineIcon />
                        Edit…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => void remove(c)}>
                        <Trash2Icon />
                        Delete…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
      )}
      <CharacterDialog target={dialog} onClose={() => setDialog(null)} onSave={save} />
    </div>
  )
}

/** "Played by": the world's players, ticked for those who play the character. */
export function PlayedByMenu({
  character,
  players,
  onToggle,
}: {
  character: WorldCharacter
  players: Array<{ userId: string; displayName: string }>
  onToggle(userId: string, plays: boolean): void
}) {
  const full = character.playerIds.length >= MAX_PLAYERS_PER_CHARACTER
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <UserPlusIcon data-icon="inline-start" />
        Played by
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Who plays {character.name}</DropdownMenuLabel>
          {players.length === 0 ? (
            <DropdownMenuItem disabled>No players have joined yet</DropdownMenuItem>
          ) : (
            players.map((p) => {
              const plays = character.playerIds.includes(p.userId)
              return (
                <DropdownMenuCheckboxItem
                  key={p.userId}
                  checked={plays}
                  disabled={!plays && full}
                  closeOnClick={false}
                  onCheckedChange={(c) => onToggle(p.userId, c)}
                >
                  <span className="truncate">{p.displayName}</span>
                </DropdownMenuCheckboxItem>
              )
            })
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
