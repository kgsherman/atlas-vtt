// Multiplayer end to end against the real Supabase backend (the app's default mode, from .env.local):
// two browser contexts = two anonymous users. The DM copies the Crooked Lantern sample into their
// library and starts a session; one player joins by room code; realtime runs over RLS-protected
// private channels. Checks: the player's view equals the authoritative oracle, a drag move, the
// movement lock, reload → same state, Realtime RLS refuses another user's topics and the host topic
// for writes, table RLS hides the DM's rows, no secret in any websocket frame the player received, and
// ending the session reaches the player. Cleans up: ends the session and deletes the scene copy
// (anonymous users cannot be deleted with the publishable key; they are listed at the end).
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/multiplayer-supabase.mjs
import {
  BASE,
  Checks,
  jsonDiff,
  openBrowser,
  outDir,
  rateLimited,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  findLeaks,
  hostState,
  joinGame,
  mouseDrag,
  openSceneInEditor,
  playerView,
  projectIn,
  requestMoveTo,
  sceneSecrets,
  startSession,
  viewConverges,
  waitHosting,
  waitPlayerLive,
  waitResult,
} from "./session.mjs"

const OUT = outDir("multiplayer-supabase")
const checks = new Checks("multiplayer-supabase")
const logs = []
const frames = []
const browser = await openBrowser()
let cleanup = null

const cellOf = (pos, cs) => ({
  i: Math.floor(pos.x / cs),
  j: Math.floor(pos.z / cs),
})

/** Record every websocket frame (Supabase Realtime) and REST response a page receives, as text. */
function captureSockets(page, sink) {
  // REST answers too (player_views rows, RPC results): everything data-bearing the player downloads.
  page.on("response", async (res) => {
    if (!/\/rest\/v1\//.test(res.url())) return
    try {
      sink.push({ url: res.url(), text: await res.text() })
    } catch {
      // bodies of redirects / aborted requests are unavailable
    }
  })
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) =>
      sink.push({
        url: ws.url(),
        text:
          typeof f.payload === "string"
            ? f.payload
            : Buffer.from(f.payload).toString("utf8"),
      })
    )
  })
}

try {
  // ---- DM --------------------------------------------------------------------------------------------
  checks.step("DM (anonymous user 1) starts a session from the sample")
  const dmCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const dm = await dmCtx.newPage()
  watchPage(dm, "dm", logs)
  await dm.goto(`${BASE}/?local=0`, { waitUntil: "domcontentloaded" })
  const dmIdentity = await dm.evaluate(async () => {
    const m = await import("/src/app/mode.ts")
    return m.currentMode()
  })
  checks.ok(
    dmIdentity.mode === "supabase",
    "the app runs against Supabase (not local mode)",
    dmIdentity
  )
  const sceneId = await openSceneInEditor(dm, {
    mode: "supabase",
    file: process.env.ATLAS_SCENE ?? null,
  })
  cleanup = { sceneId, sessionId: null }
  const h0 = await startSession(dm)
  const sessionId = h0.sessionId
  cleanup.sessionId = sessionId
  cleanup.sid = sessionId
  checks.ok(
    /^[0-9A-Z]{8}$/.test(h0.roomCode),
    `hosting session ${sessionId.slice(0, 8)}… with room code ${h0.roomCode}`
  )
  const scene0 = h0.state.scene
  const cs = scene0.grid.cellSize
  const secrets = sceneSecrets(scene0)

  // ---- player ------------------------------------------------------------------------------------------
  checks.step(
    "Player (anonymous user 2, separate browser context) joins by room code"
  )
  const plCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  plCtx.on("page", (page) => captureSockets(page, frames))
  const tJoin = Date.now()
  const player = await joinGame(plCtx, {
    roomCode: h0.roomCode,
    name: "Morgana",
    mode: "supabase",
    logs,
  })
  const pl = player.page
  const uid = player.uid
  checks.ok(
    true,
    `joined and live over Realtime in ${((Date.now() - tJoin) / 1000).toFixed(1)} s`
  )
  await waitFor(
    dm,
    () => window.__atlasHost.runner.getSnapshot().members.some((m) => m.linked),
    null,
    { timeout: 30000, label: "member linked" }
  )
  const hostUid = await dm.evaluate(async () =>
    (await import("/src/net/supabase.ts"))
      .getSupabase()
      .auth.getUser()
      .then((r) => r.data.user?.id ?? null)
  )
  checks.ok(
    hostUid && uid && hostUid !== uid,
    "DM and player are different anonymous users",
    { hostUid, uid }
  )

  checks.step(
    "DM assigns a character; the player's view is the authoritative one"
  )
  const pcs = Object.values(scene0.tokens).filter(
    (t) => t.kind === "pc" && !t.hidden
  )
  const pip = pcs.find((t) => /^(Pip|Wren)/.test(t.name)) ?? pcs[0]
  await assignToken(dm, player, pip)
  checks.eq(
    await viewConverges(dm, pl, uid, 15000),
    [],
    "player's view equals the oracle (fresh vision + filter)"
  )
  if (Object.values(scene0.levels).some((l) => l.backdrop)) {
    // Map tiles: the host uploads this player's explored cells in 4×4-cell chunks to the private
    // session-tiles bucket (under the player's user id) and announces them; the player downloads its own.
    const tTiles = Date.now()
    await waitFor(
      pl,
      () => {
        const layers = window.__atlasPlayer.client.backdropLayers()
        return (
          layers.length > 0 &&
          layers.every(
            (l) =>
              l.stats.drawn > 0 &&
              l.stats.pending === 0 &&
              l.stats.missing === 0
          )
        )
      },
      null,
      { timeout: 60000, label: "backdrop tiles composited" }
    ).then(
      () =>
        checks.ok(
          true,
          `backdrop tiles arrive through Storage (per-player chunks) in ${((Date.now() - tTiles) / 1000).toFixed(1)} s`
        ),
      (e) =>
        checks.fail(
          "backdrop tiles arrive through Storage (per-player chunks)",
          e.message
        )
    )
    const stats = await pl.evaluate(() =>
      window.__atlasPlayer.client
        .backdropLayers()
        .map((l) => ({ level: l.levelId, ...l.stats }))
    )
    console.log("   tiles:", JSON.stringify(stats))
    const probe = await pl.evaluate(
      async ({ sid, uid, hostUid }) => {
        const { getSupabase } = await import("/src/net/supabase.ts")
        const { chunkOfCell, chunkPath } =
          await import("/src/net/assets/index.ts")
        const { cellTouched, decodeMask } =
          await import("/src/core/vision/mask.ts")
        const c = getSupabase()
        const snap = window.__atlasPlayer.client.getSnapshot()
        const level = Object.keys(snap.view.backdrops ?? {})[0]
        const ex = snap.view.masks[level].explored
        const mask = decodeMask(ex)
        // Fully or partly explored (a partly explored cell ships only its explored sub-cells).
        const explored = (i, j) => cellTouched(mask, j * ex.width + i)
        // A chunk with no explored cell: the host never uploads it.
        let hidden = null
        for (let k = ex.width * ex.depth - 1; k >= 0 && !hidden; k--) {
          const i = k % ex.width
          const j = Math.floor(k / ex.width)
          const { ci, cj } = chunkOfCell(i, j)
          let any = false
          for (let v = 0; v < 4; v++)
            for (let u = 0; u < 4; u++)
              if (
                ci * 4 + u < ex.width &&
                cj * 4 + v < ex.depth &&
                explored(ci * 4 + u, cj * 4 + v)
              )
                any = true
          if (!any) hidden = { ci, cj }
        }
        const dl = async (path) => {
          const r = await c.storage
            .from("session-tiles")
            .download(path, { cacheNonce: String(Date.now()) })
          return r.data ? "downloaded" : "refused"
        }
        return {
          unexplored: hidden
            ? await dl(chunkPath(sid, uid, level, hidden.ci, hidden.cj))
            : "none",
          dmFolder: await dl(chunkPath(sid, hostUid, level, 0, 0)),
          otherUser: await dl(chunkPath(sid, crypto.randomUUID(), level, 0, 0)),
          listOthers:
            (
              await c.storage.from("session-tiles").list(sid, { limit: 100 })
            ).data?.map((f) => f.name) ?? [],
          assetFolders:
            (await c.storage.from("scene-assets").list("", { limit: 10 })).data
              ?.length ?? 0,
        }
      },
      { sid: sessionId, uid, hostUid }
    )
    checks.ok(
      probe.unexplored !== "downloaded" &&
        probe.dmFolder === "refused" &&
        probe.otherUser === "refused",
      "no tile outside the player's own explored chunks can be downloaded",
      probe
    )
    checks.ok(
      probe.listOthers.every((n) => n === uid),
      "listing the session's tiles shows only the player's own folder",
      probe.listOthers
    )
    checks.eq(
      probe.assetFolders,
      0,
      "the DM's full map images are not listable by the player"
    )
    // A partly explored cell ships only its explored 4×4 sub-cells: download the player's chunks that
    // hold such cells and decode them in the page (the canvas codec does not exist in Node).
    const clip = await pl.evaluate(
      async ({ sid, uid }) => {
        const { getSupabase } = await import("/src/net/supabase.ts")
        const { chunkOfCell, chunkPath, TILE_CHUNK } =
          await import("/src/net/assets/index.ts")
        const { decodeMask } = await import("/src/core/vision/mask.ts")
        const SUB = 4
        const INSET = 3 // px kept clear of sub-cell edges (antialiasing at the clip edge is allowed)
        const snap = window.__atlasPlayer.client.getSnapshot()
        const cs = snap.scene.grid.cellSize
        const out = {
          chunks: 0,
          partialCells: 0,
          unexplored: 0,
          leaking: [],
          explored: 0,
          opaque: 0,
          errors: [],
        }
        for (const [levelId, bd] of Object.entries(snap.view.backdrops ?? {})) {
          const ex = snap.view.masks[levelId]?.explored
          if (!ex) continue
          const mask = decodeMask(ex)
          // Partly explored cells lying wholly inside the image, grouped by chunk.
          const byChunk = new Map()
          for (const [index, sub] of mask.partial) {
            const i = index % ex.width
            const j = Math.floor(index / ex.width)
            const inside =
              i * cs >= bd.rect.x &&
              (i + 1) * cs <= bd.rect.x + bd.rect.w &&
              j * cs >= bd.rect.z &&
              (j + 1) * cs <= bd.rect.z + bd.rect.d
            if (!inside) continue
            const { ci, cj } = chunkOfCell(i, j)
            const key = `${ci},${cj}`
            if (!byChunk.has(key)) byChunk.set(key, { ci, cj, cells: [] })
            byChunk.get(key).cells.push({ i, j, sub })
          }
          for (const { ci, cj, cells } of [...byChunk.values()].slice(0, 4)) {
            const r = await getSupabase()
              .storage.from("session-tiles")
              .download(chunkPath(sid, uid, levelId, ci, cj), {
                cacheNonce: String(Date.now()),
              })
            if (!r.data) {
              out.errors.push(`${ci}_${cj}: ${r.error?.message ?? "no data"}`)
              continue
            }
            const bmp = await createImageBitmap(r.data, {
              premultiplyAlpha: "none",
            })
            const canvas = new OffscreenCanvas(bmp.width, bmp.height)
            const g = canvas.getContext("2d", { willReadFrequently: true })
            g.drawImage(bmp, 0, 0)
            const px = bmp.width / TILE_CHUNK
            out.chunks++
            for (const { i, j, sub } of cells) {
              out.partialCells++
              const ox = (i - ci * TILE_CHUNK) * px
              const oy = (j - cj * TILE_CHUNK) * px
              for (let sz = 0; sz < SUB; sz++) {
                for (let sx = 0; sx < SUB; sx++) {
                  const x0 = Math.ceil(ox + (sx * px) / SUB) + INSET
                  const y0 = Math.ceil(oy + (sz * px) / SUB) + INSET
                  const x1 = Math.floor(ox + ((sx + 1) * px) / SUB) - INSET
                  const y1 = Math.floor(oy + ((sz + 1) * px) / SUB) - INSET
                  if (x1 <= x0 || y1 <= y0) continue
                  const data = g.getImageData(x0, y0, x1 - x0, y1 - y0).data
                  let maxA = 0
                  for (let k = 3; k < data.length; k += 4)
                    maxA = Math.max(maxA, data[k])
                  if (sub & (1 << (sz * SUB + sx))) {
                    out.explored++
                    if (maxA > 0) out.opaque++
                  } else {
                    out.unexplored++
                    if (maxA > 0)
                      out.leaking.push(
                        `${levelId.slice(0, 6)} ${i},${j} sub ${sx},${sz} α${maxA}`
                      )
                  }
                }
              }
            }
          }
        }
        return out
      },
      { sid: sessionId, uid }
    )
    console.log(
      `   sub-cell clipping: ${clip.chunks} chunks, ${clip.partialCells} partly explored cells, ${clip.unexplored} unexplored / ${clip.explored} explored sub-cells (${clip.opaque} opaque)`
    )
    if (clip.partialCells === 0)
      console.log(
        "   (no partly explored cell inside a backdrop: nothing to check)"
      )
    else {
      checks.ok(
        clip.errors.length === 0,
        "the player can download its own chunks that hold partly explored cells",
        clip.errors.slice(0, 3)
      )
      checks.eq(
        clip.leaking.slice(0, 5),
        [],
        "partly explored cells ship no art in their unexplored sub-cells (alpha 0)"
      )
      checks.ok(clip.opaque > 0, "their explored sub-cells carry the art", clip)
    }
  }
  await sleep(1500)
  await shot(pl, OUT, "01-player-initial")

  checks.step("Player drags the token")
  const s0 = await pl.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasPlayer.client.getSnapshot().scene))
  )
  const t0 = s0.tokens[pip.id]
  const elev = s0.levels[t0.levelId].elevation
  const c0 = cellOf(t0.position, cs)
  const target = { i: c0.i - 4, j: c0.j + 3 }
  await pl.evaluate((id) => window.__atlasPlayer.select(id), pip.id)
  const from = await projectIn(pl, "__atlasPlayer", {
    x: t0.position.x,
    y: elev + 0.5,
    z: t0.position.z,
  })
  const to = await projectIn(pl, "__atlasPlayer", {
    x: (target.i + 0.5) * cs,
    y: elev,
    z: (target.j + 0.5) * cs,
  })
  const tMove = Date.now()
  await mouseDrag(pl, from, to)
  await waitFor(
    pl,
    ({ id, x, z }) => {
      const t = window.__atlasPlayer.client.getSnapshot().scene.tokens[id]
      return t.position.x !== x || t.position.z !== z
    },
    { id: pip.id, ...t0.position },
    { timeout: 15000, label: "token moved" }
  )
  checks.ok(
    true,
    `move confirmed by the host through Realtime in ${Date.now() - tMove} ms (incl. drag gesture)`
  )
  checks.eq(
    cellOf((await hostState(dm)).state.scene.tokens[pip.id].position, cs),
    target,
    "the host moved the token to the dropped cell"
  )
  checks.eq(
    await viewConverges(dm, pl, uid, 15000),
    [],
    "player's view equals the oracle after the move"
  )
  await sleep(1000)
  await shot(pl, OUT, "02-player-moved")

  checks.step("Movement lock → rejected move")
  await dm.getByRole("tab", { name: /Table/ }).click()
  await dm.getByRole("switch", { name: /Lock all movement/ }).click()
  await waitFor(
    pl,
    () =>
      window.__atlasPlayer.client.getSnapshot().view.flags.movementLocked ===
      true,
    null,
    { timeout: 15000, label: "locked flag" }
  )
  const locked = await requestMoveTo(pl, pip.id, {
    i: target.i + 1,
    j: target.j,
  })
  const res = await waitResult(pl, locked.reqId, 15000)
  checks.ok(
    res.ok === false && /locked/.test(`${res.reason} ${res.local ?? ""}`),
    "move rejected: movement-locked",
    res
  )

  checks.step("Reload → rejoin in the same state")
  const before = await playerView(pl)
  await pl.reload({ waitUntil: "domcontentloaded" })
  await waitPlayerLive(pl, 45000)
  await waitFor(
    pl,
    (id) =>
      window.__atlasPlayer.client
        .getSnapshot()
        .view?.controlledTokenIds.includes(id),
    pip.id,
    { timeout: 20000, label: "token after reload" }
  )
  checks.eq(
    jsonDiff(before, await playerView(pl)),
    [],
    "after reload the view is identical"
  )
  await dm.getByRole("switch", { name: /Lock all movement/ }).click()

  checks.step("The DM reloads (new host run, claim_host) → the player resumes")
  // The unlock above is saved urgently; give the fenced save a moment, then reload the host tab.
  await sleep(1500)
  const beforeHost = await playerView(pl)
  const epochBefore = await pl.evaluate(
    () => window.__atlasPlayer.client.getSnapshot().epoch
  )
  const tilesBefore = await dm.evaluate(
    () => window.__atlasHost.runner.tiler?.stats ?? null
  )
  await dm.reload({ waitUntil: "domcontentloaded" })
  await waitHosting(dm, 60000)
  await waitFor(
    pl,
    (epoch) => {
      const s = window.__atlasPlayer.client.getSnapshot()
      return s.status === "live" && s.epoch !== epoch
    },
    epochBefore,
    { timeout: 45000, label: "player follows the new host run" }
  )
  checks.eq(
    jsonDiff(beforeHost, await playerView(pl)),
    [],
    "same view after the host restart"
  )
  if (Object.values(scene0.levels).some((l) => l.backdrop)) {
    // The new run re-uploads the explored chunks and announces them again.
    await waitFor(
      pl,
      () =>
        window.__atlasPlayer.client
          .backdropLayers()
          .every((l) => l.stats.pending === 0 && l.stats.missing === 0),
      null,
      { timeout: 60000, label: "tiles after the host restart" }
    ).then(
      () => checks.ok(true, "backdrop tiles intact after the host restart"),
      (e) =>
        checks.fail("backdrop tiles intact after the host restart", e.message)
    )
  }

  checks.step("Row-level security")
  // Frames from here on include the replies to this step's refused joins; scan the traffic before it.
  const gameFrames = frames.length
  const rls = await pl.evaluate(
    async ({ sid, hostUid }) => {
      const { getSupabase } = await import("/src/net/supabase.ts")
      const { createPrivateChannel, topics } =
        await import("/src/net/channels.ts")
      const c = getSupabase()
      await c.realtime.setAuth()
      const join = (topic) =>
        new Promise((resolve) => {
          const ch = createPrivateChannel(c, topic)
          const timer = setTimeout(() => {
            void c.removeChannel(ch)
            resolve("TIMEOUT")
          }, 12000)
          ch.subscribe((status) => {
            if (
              status === "SUBSCRIBED" ||
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT"
            ) {
              clearTimeout(timer)
              void c.removeChannel(ch)
              resolve(status)
            }
          })
        })
      const other = crypto.randomUUID()
      const sessions = await c.from("sessions").select("id").eq("id", sid)
      const state = await c
        .from("session_state")
        .select("session_id")
        .eq("session_id", sid)
      const views = await c
        .from("player_views")
        .select("user_id")
        .eq("session_id", sid)
      const save = await c.rpc("save_session_state", {
        p_session_id: sid,
        p_host_epoch: 999999,
        p_state: {},
      })
      return {
        dmViewTopic: await join(topics.view(sid, hostUid)),
        otherReqTopic: await join(topics.req(sid, other)),
        sessionsRows: sessions.data?.length ?? sessions.error?.code,
        stateRows: state.data?.length ?? state.error?.code,
        viewRows: (views.data ?? []).map((r) => r.user_id),
        saveError: save.error?.message ?? null,
      }
    },
    { sid: sessionId, hostUid }
  )
  checks.ok(
    rls.dmViewTopic !== "SUBSCRIBED",
    "Realtime refuses the player on another user's view topic",
    rls.dmViewTopic
  )
  checks.ok(
    rls.otherReqTopic !== "SUBSCRIBED",
    "Realtime refuses the player on another user's request topic",
    rls.otherReqTopic
  )
  checks.ok(
    rls.sessionsRows === 0 && rls.stateRows === 0,
    "the player cannot read the sessions / session_state rows",
    rls
  )
  checks.ok(
    rls.viewRows.every((u) => u === uid),
    "the player reads only their own player_views row",
    rls.viewRows
  )
  checks.ok(
    !!rls.saveError,
    "save_session_state is refused for the player",
    rls.saveError
  )

  checks.step("Nothing secret in the player's websocket traffic")
  const game = frames.slice(0, gameFrames)
  const bytes = game.reduce((n, f) => n + f.text.length, 0)
  checks.ok(
    game.length > 0,
    `captured ${game.length} websocket frames and REST responses during play (${(bytes / 1024).toFixed(1)} KB, ${game.filter((f) => f.url.includes("/rest/v1/")).length} REST)`
  )
  const leaks = findLeaks(
    frames.map((f, k) => ({ where: `frame #${k}`, text: f.text })),
    secrets
  )
  checks.eq(
    leaks.slice(0, 5),
    [],
    "no hidden token / secret door / DM note / object name in any frame"
  )
  const topicUsers = (f) =>
    [
      ...f.text.matchAll(/session:[0-9a-f-]{36}:(?:view|req):([0-9a-f-]{36})/g),
    ].map((m) => m[1])
  const foreignTopics = [...new Set(game.flatMap(topicUsers))].filter(
    (u) => u !== uid
  )
  checks.eq(foreignTopics, [], "no frame on another user's topic during play")
  const probeData = frames
    .slice(gameFrames)
    .filter(
      (f) =>
        topicUsers(f).some((u) => u !== uid) &&
        /"broadcast"|"presence_(state|diff)"/.test(f.text)
    )
  checks.eq(
    probeData.length,
    0,
    "the refused joins delivered no broadcast or presence data"
  )

  if (Object.values(scene0.levels).some((l) => l.backdrop)) {
    // Chunk traffic of the whole run (initial view, moves, reloads, host restart).
    const tiler = await dm.evaluate(
      () => window.__atlasHost.runner.tiler?.stats ?? null
    )
    console.log(
      `   host tile uploads: first host run ${JSON.stringify(tilesBefore)}, after the DM's reload ${JSON.stringify(tiler)} (browser-logged 429s: ${rateLimited(logs)})`
    )
  }

  checks.step("DM ends the session")
  await dm.getByRole("button", { name: "End session" }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "End session" })
    .click()
  await waitFor(
    pl,
    () =>
      ["ended", "kicked"].includes(
        window.__atlasPlayer?.client.getSnapshot().status
      ) || document.body.innerText.includes("ended"),
    null,
    { timeout: 20000, label: "player sees the end" }
  ).then(
    () => checks.ok(true, "the player is told the session ended"),
    (e) => checks.fail("the player is told the session ended", e.message)
  )
  await shot(pl, OUT, "03-player-ended")
  cleanup.sessionId = null
  if (Object.values(scene0.levels).some((l) => l.backdrop)) {
    // The host deletes the players' tile chunks once the session has ended (best effort, in the background).
    const leftover = async () =>
      dm.evaluate(async (sid) => {
        const { getSupabase } = await import("/src/net/supabase.ts")
        const bucket = getSupabase().storage.from("session-tiles")
        const count = async (folder, depth) => {
          const { data } = await bucket.list(folder, { limit: 1000 })
          let n = 0
          for (const e of data ?? [])
            n +=
              e.id === null && depth < 3
                ? await count(`${folder}/${e.name}`, depth + 1)
                : e.id === null
                  ? 0
                  : 1
          return n
        }
        return count(sid, 1)
      }, sessionId)
    const tEnd = Date.now()
    let left = await leftover()
    while (left > 0 && Date.now() - tEnd < 20000) {
      await sleep(1000)
      left = await leftover()
    }
    checks.eq(left, 0, "ending the session deletes the players' map tiles")
  }
} catch (err) {
  checks.fail("multiplayer-supabase crashed", err)
} finally {
  // Cleanup through the DM's own identity: end the session if still active, delete the scene copy.
  if (cleanup) {
    try {
      const ctx = browser.contexts()[0]
      const page = ctx?.pages()[0]
      if (page) {
        const done = await page.evaluate(
          async ({ sceneId, sessionId, cleanupSid }) => {
            const m = await import("/src/app/createServices.ts")
            const { removeSessionTiles } =
              await import("/src/net/assets/index.ts")
            const { getSupabase } = await import("/src/net/supabase.ts")
            const s = await m.createServices({ mode: "supabase" })
            if (sessionId)
              await s.sessions.endSession(sessionId).catch(() => false)
            // Uploaded map images (stored under the scene DOCUMENT id), any tiles the host left behind,
            // then the library row.
            const scene = await s.scenes.load(sceneId).catch(() => null)
            const doc = scene?.parsed?.ok ? scene.parsed.scene : null
            const assets = Object.keys(doc?.assets ?? {})
            let deleted = 0
            for (const id of assets) {
              const ok = await s.assets
                .deleteImage(doc.id, id)
                .then(() => true)
                .catch(() => false)
              if (ok) deleted++
            }
            const left = doc
              ? ((
                  await getSupabase()
                    .storage.from("scene-assets")
                    .list(`${s.identity.userId}/${doc.id}`)
                ).data?.length ?? 0)
              : 0
            const tiles = cleanupSid
              ? await removeSessionTiles(getSupabase(), cleanupSid).catch(
                  () => -1
                )
              : 0
            await s.scenes.remove(sceneId)
            return { userId: s.identity.userId, assets: deleted, left, tiles }
          },
          { ...cleanup, cleanupSid: cleanup.sid }
        )
        console.log(
          `  cleanup: session ended, scene ${cleanup.sceneId} deleted with ${done.assets} map images (${done.left} left) and ${done.tiles} leftover tiles (anonymous DM user ${done.userId} remains)`
        )
      }
    } catch (err) {
      console.log(`  cleanup failed: ${err.message}`)
    }
  }
  const errors = seriousErrors(logs)
  if (rateLimited(logs) > 0)
    console.log(
      `  (${rateLimited(logs)} requests were rate limited by Supabase and retried)`
    )
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 6).join("\n")
  )
  await browser.close()
  checks.done()
}
