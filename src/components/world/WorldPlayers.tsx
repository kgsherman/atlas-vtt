/**
 * A world's players (ARCHITECTURE §6.9): who joined with its room code, the characters each plays, and
 * removing a player from the world (every table of it at once) or letting them back.
 */
import { CopyIcon, EllipsisIcon, UndoIcon, UserMinusIcon, UserRoundPlusIcon, UsersRoundIcon } from "lucide-react"

import { copyText } from "@/app/clipboard"
import { formatRelativeTime } from "@/app/format"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { useNow } from "@/app/useAsync"
import { useConfirm } from "@/components/editor/context"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { formatRoomCode } from "@/net/roomCodes"
import { MAX_PLAYERS_PER_CHARACTER, type WorldMember } from "@/net/worldsRepo"
import { cn } from "@/lib/utils"

import { initialsOf } from "@/lib/initials"

import { CharacterAvatar } from "./CharacterAvatar"
import type { RosterActions, WorldRoster } from "./roster"

export function WorldPlayers({ roster, actions, roomCode }: { roster: WorldRoster; actions: RosterActions; roomCode: string }) {
  const confirm = useConfirm()
  const now = useNow()
  const active = roster.members.filter((m) => m.status === "active")
  const removed = roster.members.filter((m) => m.status === "kicked")
  const invite = () => void copyText(inviteLink(window.location.origin, roomCode, withModeParam("")), "Invite link")

  const kick = async (m: WorldMember) => {
    const ok = await confirm({
      title: `Remove ${m.displayName} from the world?`,
      description:
        "They are disconnected from every table of the world and can't join again with the room code. Their characters wait for them: let them back in to return them.",
      confirmLabel: "Remove player",
      destructive: true,
    })
    if (ok) await actions.setMemberStatus(m.userId, "kicked")
  }

  if (roster.members.length === 0) {
    return (
      <Empty className="border border-dashed py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserRoundPlusIcon />
          </EmptyMedia>
          <EmptyTitle>No players yet</EmptyTitle>
          <EmptyDescription>
            Players join the world once with its room code, <span className="font-mono tracking-wider text-foreground">{formatRoomCode(roomCode)}</span>. You
            can then hand them their characters, and they come to whichever table of the world you open.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={invite}>
            <CopyIcon data-icon="inline-start" />
            Copy invite link
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  const row = (m: WorldMember) => {
    const plays = roster.characters.filter((c) => c.playerIds.includes(m.userId))
    const kicked = m.status === "kicked"
    return (
      <Item key={m.userId} variant="outline" className={cn("bg-card/60", kicked && "opacity-70")}>
        <ItemMedia>
          <Avatar>
            <AvatarFallback className="text-[0.6875rem] font-medium">{initialsOf(m.displayName)}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="gap-1.5">
            <span className="truncate">{m.displayName}</span>
            {kicked && <Badge variant="destructive">Removed</Badge>}
          </ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-1">
            <span>Joined {formatRelativeTime(m.joinedAt, now)}</span>
            {plays.map((c) => (
              <Badge key={c.id} variant="outline" className="h-5 gap-1 pl-0.5">
                <CharacterAvatar character={c} size="sm" className="size-4 ring-1 ring-offset-0" />
                {c.name}
              </Badge>
            ))}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="gap-1">
          {!kicked && roster.characters.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <UsersRoundIcon data-icon="inline-start" />
                Characters
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{m.displayName} plays</DropdownMenuLabel>
                  {roster.characters.map((c) => {
                    const on = c.playerIds.includes(m.userId)
                    return (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={on}
                        disabled={!on && c.playerIds.length >= MAX_PLAYERS_PER_CHARACTER}
                        closeOnClick={false}
                        onCheckedChange={(next) => void actions.togglePlayer(c, m.userId, next)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                          <span className="truncate">{c.name}</span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${m.displayName}`} />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {kicked ? (
                <DropdownMenuItem onClick={() => void actions.setMemberStatus(m.userId, "active")}>
                  <UndoIcon />
                  Let back in
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onClick={() => void kick(m)}>
                  <UserMinusIcon />
                  Remove from the world…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </Item>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Everyone who joined with the room code. They come to whichever table of the world is open.</p>
        <Button variant="outline" size="sm" onClick={invite}>
          <CopyIcon data-icon="inline-start" />
          Copy invite link
        </Button>
      </div>
      <ItemGroup className="gap-2">{active.map(row)}</ItemGroup>
      {removed.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-medium text-muted-foreground">Removed</h3>
          <ItemGroup className="gap-2">{removed.map(row)}</ItemGroup>
        </>
      )}
    </div>
  )
}
