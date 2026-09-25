/**
 * Getting the token out: a PNG download at any size, and "Use in a game": the games open in this
 * browser's other tabs (net/tokenMakerLink) and the tokens their user may re-skin. Applying uploads the
 * game-sized token to the token image store and asks the game tab to put it on the chosen token.
 */
import * as React from "react"
import { Check, CircleUserRound, Crown, Download, Send, Swords } from "lucide-react"
import { toast } from "sonner"

import { downloadBlob } from "@/app/clipboard"
import { useServices } from "@/app/services"
import { FieldRow, Hint, PanelSection, SelectInput } from "@/components/editor/fields"
import { TokenAvatar } from "@/components/play/TokenAvatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TOKEN_OUTPUT_SIZES } from "@/core/tokenMaker/design"
import { cn } from "@/lib/utils"
import { describeNetError, isNetError } from "@/net/supabase"
import type { LinkedGame } from "@/net/tokenMakerLink"
import { downloadName, exportPng, uploadForGame } from "@/tokenMaker/actions"

import { useLinkedGames, useMaker, useTokenMaker } from "./context"

type SizeOption = `${(typeof TOKEN_OUTPUT_SIZES)[number]}`

export function DownloadSection() {
  const { store, cache } = useTokenMaker()
  const empty = useMaker((s) => s.design.layers.length === 0)
  const [size, setSize] = React.useState<SizeOption>("512")
  const [busy, setBusy] = React.useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const px = Number(size)
      const blob = await exportPng(store, cache, px)
      downloadBlob(downloadName(store.getState().design, px), blob)
    } catch (err) {
      toast.error("Couldn't make the PNG", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <PanelSection title="Download">
      <FieldRow label="Size">
        <SelectInput<SizeOption>
          value={size}
          onValueChange={setSize}
          options={TOKEN_OUTPUT_SIZES.map((s) => ({ value: `${s}` as SizeOption, label: `${s} × ${s} px` }))}
        />
      </FieldRow>
      <Button disabled={empty || busy} onClick={() => void download()}>
        {busy ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />} Download PNG
      </Button>
    </PanelSection>
  )
}

function gameLabel(g: LinkedGame): string {
  return `${g.title || "Untitled scene"} · ${g.role === "dm" ? "DM" : "Player"}`
}

function errorText(err: unknown): string {
  if (isNetError(err)) return err.code === "quota_exceeded" ? "You have stored too many token images." : (err.detail ?? describeNetError(err.code))
  return err instanceof Error ? err.message : String(err)
}

export function GameSection({ preferredSession, preferredToken }: { preferredSession: string | null; preferredToken: string | null }) {
  const { store, cache, link } = useTokenMaker()
  const services = useServices()
  const empty = useMaker((s) => s.design.layers.length === 0)
  const games = useLinkedGames()
  const [tabId, setTabId] = React.useState<string | null>(null)
  const [tokenId, setTokenId] = React.useState<string | null>(preferredToken)
  const [busy, setBusy] = React.useState(false)

  // The chosen game: the one picked, else the game this tab was opened for (ready tabs first), else the newest.
  const game =
    games.find((g) => g.tabId === tabId) ??
    [...games].sort((a, b) => Number(b.sessionId === preferredSession) - Number(a.sessionId === preferredSession) || Number(b.ready) - Number(a.ready))[0] ??
    null
  const token = game?.tokens.find((t) => t.id === tokenId) ?? null

  const apply = async () => {
    if (!game || !token) return
    setBusy(true)
    try {
      const url = await uploadForGame(store, cache, services.tokenImages)
      const r = await link.apply(game.tabId, token.id, url)
      if (r.ok) toast.success(`${token.name} has a new token`, { description: game.title || undefined })
      else toast.error("The game didn't take the token", { description: r.error ?? undefined })
    } catch (err) {
      toast.error("Couldn't upload the token", { description: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  let body: React.ReactNode
  if (!services.tokenImages.available) {
    body = <Hint>Putting tokens on game tokens needs Atlas Cloud. Download the PNG and use it anywhere instead.</Hint>
  } else if (!link.supported) {
    body = <Hint>This browser can't talk to your game tabs. Download the PNG instead.</Hint>
  } else if (!game) {
    body = (
      <Hint>
        Open your game in another tab of this browser (as the DM or as a player) and it shows up here. The <CircleUserRound className="inline size-3" /> button
        at the table opens this page for it.
      </Hint>
    )
  } else {
    body = (
      <>
        {games.length > 1 ? (
          <FieldRow label="Game">
            <SelectInput value={game.tabId} onValueChange={setTabId} options={games.map((g) => ({ value: g.tabId, label: gameLabel(g) }))} />
          </FieldRow>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            {game.role === "dm" ? <Crown className="size-3.5 text-muted-foreground" /> : <Swords className="size-3.5 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate font-medium">{game.title || "Untitled scene"}</span>
            <Badge variant="outline">{game.role === "dm" ? "DM" : "Player"}</Badge>
          </div>
        )}
        {!game.ready ? <Hint>Waiting for that game to connect…</Hint> : null}
        {game.tokens.length === 0 ? (
          <Hint>{game.role === "dm" ? "This scene has no tokens yet." : "The DM hasn't given you a character yet."}</Hint>
        ) : (
          <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto" aria-label="Tokens">
            {game.tokens.map((t) => {
              const on = t.id === token?.id
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTokenId(t.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg p-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      on ? "bg-muted ring-1 ring-border" : "hover:bg-muted/50"
                    )}
                  >
                    <TokenAvatar token={{ name: t.name, label: null, color: t.color, imageUrl: t.imageUrl }} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    {on ? <Check className="size-3.5 text-primary" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <Button disabled={empty || busy || !token || !game.ready} onClick={() => void apply()}>
          {busy ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          {token ? `Put on ${token.name}` : "Pick a token"}
        </Button>
      </>
    )
  }

  return <PanelSection title="Use in a game">{body}</PanelSection>
}
