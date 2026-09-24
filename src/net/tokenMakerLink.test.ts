import { describe, expect, it } from "vitest"

import { GameLink, MakerLink, parseLinkMessage, STALE_MS, type ChannelLike, type GameInfo } from "./tokenMakerLink"

/** In-memory BroadcastChannel: every channel of a hub receives what the others post (not its own). */
function hub() {
  const members = new Set<{ listeners: Set<(ev: MessageEvent) => void> }>()
  const channel = (): ChannelLike => {
    const me = { listeners: new Set<(ev: MessageEvent) => void>() }
    members.add(me)
    return {
      postMessage(message) {
        const data = structuredClone(message)
        for (const m of members) if (m !== me) for (const l of m.listeners) queueMicrotask(() => l({ data } as MessageEvent))
      },
      addEventListener: (_t, l) => me.listeners.add(l),
      removeEventListener: (_t, l) => me.listeners.delete(l),
      close: () => members.delete(me),
    }
  }
  return { channel, post: (msg: unknown) => channel().postMessage(msg) }
}

function fakeTimers() {
  let now = 0
  const intervals: Array<{ fn: () => void; ms: number; next: number }> = []
  const timeouts = new Map<number, { fn: () => void; at: number }>()
  let seq = 0
  return {
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms, next: now + ms }),
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.set(++seq, { fn, at: now + ms })
      return seq
    },
    clearTimeout: (h: unknown) => timeouts.delete(h as number),
    now: () => now,
    advance(ms: number) {
      now += ms
      for (const i of intervals) {
        while (i.next <= now) {
          i.next += i.ms
          i.fn()
        }
      }
      for (const [k, t] of timeouts) {
        if (t.at > now) continue
        timeouts.delete(k)
        t.fn()
      }
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const game = (over: Partial<GameInfo> = {}): GameInfo => ({
  sessionId: "sess-1",
  role: "player",
  title: "The Crooked Lantern",
  userId: "u1",
  ready: true,
  tokens: [{ id: "tok1", name: "Brunhild", color: "#aa3344", imageUrl: null }],
  ...over,
})

describe("parseLinkMessage", () => {
  it("accepts link messages and drops anything else", () => {
    expect(parseLinkMessage({ t: "discover" })).toEqual({ t: "discover" })
    expect(parseLinkMessage({ t: "gone", tabId: "abc" })).toEqual({ t: "gone", tabId: "abc" })
    expect(parseLinkMessage({ t: "discover", extra: 1 })).toBeNull()
    expect(parseLinkMessage({ t: "apply", reqId: "r", tabId: "t", tokenId: "x", imageUrl: "" })).toBeNull()
    expect(parseLinkMessage({ t: "game", game: { ...game(), tabId: "t", tokens: [{ id: "x", name: "X", color: "red", imageUrl: null }] } })).toBeNull()
    expect(parseLinkMessage("discover")).toBeNull()
    expect(parseLinkMessage(null)).toBeNull()
  })
})

describe("token maker link", () => {
  it("discovers open games and applies through the right tab", async () => {
    const h = hub()
    const timers = fakeTimers()
    const applied: Array<[string, string]> = []
    const gameLink = new GameLink(
      async (tokenId, url) => {
        applied.push([tokenId, url])
        return { ok: true, error: null }
      },
      { channel: h.channel(), timers }
    )
    gameLink.update(game())
    const other = new GameLink(async () => ({ ok: false, error: "wrong tab" }), { channel: h.channel(), timers })
    other.update(game({ sessionId: "sess-2", role: "dm", userId: "u1" }))
    await flush()

    // A Token Maker opened later asks, and both answer.
    const maker = new MakerLink({ channel: h.channel(), timers })
    let changes = 0
    maker.subscribe(() => changes++)
    await flush()
    expect(
      maker
        .getGames()
        .map((g) => g.sessionId)
        .sort()
    ).toEqual(["sess-1", "sess-2"])
    expect(changes).toBeGreaterThan(0)

    const r = maker.apply(gameLink.tabId, "tok1", "https://x/u1/a.png")
    await flush()
    await flush()
    expect(await r).toEqual({ ok: true, error: null })
    expect(applied).toEqual([["tok1", "https://x/u1/a.png"]])

    // Tokens the tab does not offer, and tabs that are not ready, are refused without applying.
    const foreign = maker.apply(gameLink.tabId, "someone-else", "https://x/u1/a.png")
    await flush()
    await flush()
    expect(await foreign).toEqual({ ok: false, error: "That token isn't yours to change." })
    gameLink.update(game({ ready: false }))
    await flush()
    const notReady = maker.apply(gameLink.tabId, "tok1", "https://x/u1/a.png")
    await flush()
    await flush()
    expect((await notReady).ok).toBe(false)
    expect(applied).toHaveLength(1)

    // A closed tab disappears.
    other.dispose()
    await flush()
    expect(maker.getGames().map((g) => g.sessionId)).toEqual(["sess-1"])
    expect(await maker.apply("gone-tab", "tok1", "u")).toEqual({ ok: false, error: "That game tab is closed." })
    maker.dispose()
    gameLink.dispose()
  })

  it("forgets silent tabs and times out unanswered applies", async () => {
    const h = hub()
    const timers = fakeTimers()
    const maker = new MakerLink({ channel: h.channel(), timers })
    h.post({ t: "game", game: { ...game(), tabId: "crashed" } })
    await flush()
    expect(maker.getGames()).toHaveLength(1)
    const pending = maker.apply("crashed", "tok1", "https://x/u1/a.png", 1000)
    timers.advance(1000)
    expect(await pending).toEqual({ ok: false, error: "The game tab didn't answer." })
    timers.advance(STALE_MS + 10_000)
    expect(maker.getGames()).toEqual([])
    maker.dispose()
  })

  it("keeps working without BroadcastChannel", async () => {
    const maker = new MakerLink({ channel: null })
    expect(maker.supported).toBe(false)
    expect(maker.getGames()).toEqual([])
    maker.dispose()
    const g = new GameLink(async () => ({ ok: true, error: null }), { channel: null })
    g.update(game())
    g.dispose()
  })
})
