/**
 * The world's characters and players from the scene screen (ARCHITECTURE §6.9): the same lists as the world
 * page, so the DM hands a character to a player who just joined without leaving the table. Changes are the
 * world's (every scene of it); `onChanged` re-reads the table's roster so the owners follow at once.
 */
import * as React from "react"

import { userMessage } from "@/app/library"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { useWorldRoster } from "./roster"
import { WorldCharacters } from "./WorldCharacters"
import { WorldPlayers } from "./WorldPlayers"

export function WorldRosterDialog({
  open,
  onOpenChange,
  world,
  onChanged,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  world: { id: string; name: string; roomCode: string } | null
  onChanged(): void
}) {
  return (
    <Dialog open={open && world !== null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-2xl">{open && world ? <RosterBody world={world} onChanged={onChanged} /> : null}</DialogContent>
    </Dialog>
  )
}

function RosterBody({ world, onChanged }: { world: { id: string; name: string; roomCode: string }; onChanged(): void }) {
  const roster = useWorldRoster(world.id, onChanged)
  const [tab, setTab] = React.useState("characters")
  return (
    <>
      <DialogHeader>
        <DialogTitle>{world.name}</DialogTitle>
        <DialogDescription>Who plays each character, in every scene of the world. A player controls the tokens linked to their characters.</DialogDescription>
      </DialogHeader>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-3">
        <TabsList>
          <TabsTrigger value="characters">Characters</TabsTrigger>
          <TabsTrigger value="players">Players</TabsTrigger>
        </TabsList>
        <ScrollArea className="-mx-1 h-[min(28rem,60vh)]">
          <div className="px-1 pb-1">
            {roster.error !== undefined && !roster.data ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn't load the characters and players</AlertTitle>
                <AlertDescription>{userMessage(roster.error)}</AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={roster.reload}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            ) : !roster.data ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : (
              <>
                <TabsContent value="characters">
                  <WorldCharacters roster={roster.data} actions={roster.actions} />
                </TabsContent>
                <TabsContent value="players">
                  <WorldPlayers roster={roster.data} actions={roster.actions} roomCode={world.roomCode} />
                </TabsContent>
              </>
            )}
          </div>
        </ScrollArea>
      </Tabs>
    </>
  )
}
