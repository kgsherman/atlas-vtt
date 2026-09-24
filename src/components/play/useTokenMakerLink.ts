/**
 * A game tab's end of the Token Maker link (net/tokenMakerLink, ARCHITECTURE §11): while the host
 * console or a player's table is open, a Token Maker tab of the same browser sees the game and its
 * tokens, and applies finished tokens through this tab.
 */
import * as React from "react"

import {
  GameLink,
  type ApplyResult,
  type GameInfo,
  type LinkedToken,
} from "@/net/tokenMakerLink"
import type { AtlasPlayerClient } from "@/net/player"

import { useSessionResource } from "./useSessionResource"

/** Announce `game` (null: nothing to offer) and apply tokens with `apply`. */
export function useGameLink(
  game: GameInfo | null,
  apply: (tokenId: string, imageUrl: string) => Promise<ApplyResult>
): void {
  const applyRef = React.useRef(apply)
  React.useEffect(() => {
    applyRef.current = apply
  })
  const link = useSessionResource(
    "token-maker-link",
    () => new GameLink((tokenId, url) => applyRef.current(tokenId, url)),
    (l) => l.dispose()
  )
  // Closing the tab: say "gone" right away rather than waiting for the Token Maker to time out.
  React.useEffect(() => {
    if (!link) return
    const bye = () => link.dispose()
    window.addEventListener("pagehide", bye)
    return () => window.removeEventListener("pagehide", bye)
  }, [link])
  const key = game ? JSON.stringify(game) : null
  React.useEffect(() => {
    link?.update(key === null ? null : (JSON.parse(key) as GameInfo))
  }, [link, key])
}

/** Tokens as the link lists them: PCs first, then by name. */
export function linkTokens(
  tokens: Iterable<{
    id: string
    name?: string
    label?: string | null
    color: string
    imageUrl: string | null
    kind?: string
  }>
): LinkedToken[] {
  const rank = (k: string | undefined) =>
    k === "pc" ? 0 : k === "npc" ? 1 : k === "monster" ? 2 : 0
  return [...tokens]
    .sort(
      (a, b) =>
        rank(a.kind) - rank(b.kind) ||
        (a.name ?? a.label ?? "").localeCompare(b.name ?? b.label ?? "")
    )
    .map((t) => ({
      id: t.id,
      name: (t.name || t.label || "Unnamed token").slice(0, 200),
      color: t.color,
      imageUrl: t.imageUrl,
    }))
}

/** Send a token-image request and wait for the host's verdict (`onRequest` learns its request id). */
export function requestTokenImage(
  client: AtlasPlayerClient,
  tokenId: string,
  imageUrl: string,
  opts: { timeoutMs?: number; onRequest?: (reqId: string) => void } = {}
): Promise<ApplyResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000
  const reqId = client.requestTokenImage(tokenId, imageUrl)
  opts.onRequest?.(reqId)
  return new Promise<ApplyResult>((resolve) => {
    let done = false
    const check = () => {
      if (done) return
      const r = client.getSnapshot().results.find((x) => x.reqId === reqId)
      if (!r) return
      done = true
      off()
      clearTimeout(timer)
      if (r.ok) resolve({ ok: true, error: null })
      else if (r.local)
        resolve({
          ok: false,
          error:
            r.local === "host-offline"
              ? "The DM is away right now."
              : "The table isn't connected right now.",
        })
      else if (r.reason === "not-owner" || r.reason === "unknown-token")
        resolve({ ok: false, error: "You don't control that token any more." })
      else resolve({ ok: false, error: "The DM's table refused that image." })
    }
    const off = client.subscribe(check)
    const timer = setTimeout(() => {
      if (done) return
      done = true
      off()
      resolve({ ok: false, error: "The DM didn't answer." })
    }, timeoutMs)
    check()
  })
}
