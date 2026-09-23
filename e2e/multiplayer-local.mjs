// Multiplayer end to end in local mode (?local=1: IndexedDB + BroadcastChannel between tabs of ONE
// browser context — BroadcastChannel does not cross contexts, so the three tabs share one context but
// have separate per-tab identities).
//
// DM opens a sample (or an .atlas.json) → starts a session → two players join by room code → the DM
// assigns characters through the Players tab → players move (mouse drag and planner paths) → every
// player's view must equal the authoritative oracle (fresh vision engine + filter) → a player opens a
// door → the DM locks movement and a move is rejected → a player reloads and rejoins in the same state
// → the DM's tab reloads (a new host run) and both players resume in the same state → no hidden token,
// attached light, secret door, DM note, object name or asset id ever reached a player (every
// BroadcastChannel frame the player tabs received, plus the stored player_views rows).
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/multiplayer-local.mjs
//   ATLAS_SCENE=/path/to/scene.atlas.json …   (default: the "The Crooked Lantern" sample)
import fs from "node:fs"

import {
  Checks,
  jsonDiff,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  clickDoor,
  drainWire,
  expectedView,
  findLeaks,
  hostState,
  joinGame,
  mouseDrag,
  openSceneInEditor,
  playerSnap,
  playerView,
  projectIn,
  reachableDoor,
  requestMoveTo,
  sceneSecrets,
  startSession,
  viewConverges,
  waitHosting,
  waitPlayerLive,
  waitResult,
} from "./session.mjs"

const OUT = outDir("multiplayer-local")
const SCENE_FILE = process.env.ATLAS_SCENE ?? null
const checks = new Checks("multiplayer-local")
const logs = []
const wire = { A: [], B: [] }
const browser = await openBrowser()

const count = (enc) => {
  // Set bits of an EncodedMask (coarse cells only).
  const bytes = Buffer.from(enc.b64, "base64")
  let n = 0
  for (const b of bytes) for (let v = b; v; v &= v - 1) n++
  return n
}
const perceivedCells = (enc) => {
  const bytes = Buffer.from(enc.b64, "base64")
  let n = 0
  for (let k = 0; k < enc.width * enc.depth; k++)
    if ((bytes[k >> 2] >> ((k & 3) * 2)) & 3) n++
  return n
}
const cellOf = (pos, cs) => ({
  i: Math.floor(pos.x / cs),
  j: Math.floor(pos.z / cs),
})

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })

  // ---- DM: scene → session ------------------------------------------------------------------------
  checks.step("DM starts a session")
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)
  await openSceneInEditor(dm, { mode: "local", file: SCENE_FILE })
  const h0 = await startSession(dm)
  checks.ok(
    /^[0-9A-Z]{8}$/.test(h0.roomCode),
    "session hosted with a room code",
    h0.roomCode
  )
  const sessionId = h0.sessionId
  const scene0 = h0.state.scene
  const cs = scene0.grid.cellSize
  const secrets = sceneSecrets(scene0)
  console.log(
    `  scene "${scene0.name}": ${secrets.ids.length} secret ids, ${secrets.strings.length} DM-only strings`
  )
  checks.ok(
    findLeaks([{ where: "DM scene", text: JSON.stringify(scene0) }], secrets)
      .length >= secrets.ids.length,
    "leak scanner finds every secret in the DM's own scene (positive control)"
  )
  await shot(dm, OUT, "01-dm-hosting")

  // ---- players join ---------------------------------------------------------------------------------
  checks.step("Two players join by room code")
  const join = async (name, key) => ({
    ...(await joinGame(context, {
      roomCode: h0.roomCode,
      name,
      capture: true,
      logs,
    })),
    key,
  })
  const A = await join("Morgana", "A")
  const B = await join("Theron", "B")
  checks.ok(
    A.uid && B.uid && A.uid !== B.uid,
    "players have distinct identities"
  )
  await waitFor(
    dm,
    (n) =>
      window.__atlasHost.runner.getSnapshot().members.filter((m) => m.linked)
        .length >= n,
    2,
    { label: "both players linked" }
  )
  checks.ok(true, "the host links both players")

  // ---- DM assigns characters ----------------------------------------------------------------------------
  checks.step("DM assigns characters in the Players tab")
  const pcs = Object.values(scene0.tokens)
    .filter((t) => t.kind === "pc" && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
  // Crooked Lantern: Brunhild (dwarf, common room) and Pip (halfling, courtyard). Otherwise the first two PCs.
  const pick = (re, k) => pcs.find((t) => re.test(t.name)) ?? pcs[k]
  const tokA = pick(/^Pip/, 0)
  const tokB = pick(/^Brunhild/, 1)
  const assign = (player, token) => assignToken(dm, player, token)
  await assign(A, tokA)
  await assign(B, tokB)
  checks.ok(
    true,
    `${A.name} controls ${tokA.name}, ${B.name} controls ${tokB.name}`
  )
  await sleep(1200)
  await shot(A.page, OUT, "02-player-A-initial")
  await shot(B.page, OUT, "03-player-B-initial")

  // ---- fog = authoritative perception ---------------------------------------------------------------------
  checks.step("Each player's view is exactly the authoritative one")
  for (const p of [A, B])
    checks.eq(
      await viewConverges(dm, p.page, p.uid),
      [],
      `${p.name}'s view equals the oracle (fresh vision + filter)`
    )
  const vA = await playerView(A.page)
  const vB = await playerView(B.page)
  const lvl = tokA.levelId
  const allCells = scene0.grid.width * scene0.grid.depth
  const pa = perceivedCells(vA.masks[lvl].perception)
  checks.ok(
    pa > 0 && pa < allCells,
    `${A.name} perceives part of the map (${pa}/${allCells} cells)`
  )
  checks.ok(
    !vA.tokens[tokB.id] || (await expectedView(dm, A.uid)).tokens[tokB.id],
    `${A.name} sees ${tokB.name} only when in line of sight`
  )
  checks.ok(
    JSON.stringify(vA.masks) !== JSON.stringify(vB.masks),
    "the two players' fog differs"
  )

  // ---- moves -----------------------------------------------------------------------------------------------
  checks.step("Players move")
  // A: a real mouse drag of the token, 4 cells west / 3 cells south (the courtyard for Pip).
  await A.page.bringToFront()
  const snapA = await A.page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasPlayer.client.getSnapshot().scene))
  )
  const startA = snapA.tokens[tokA.id]
  const elev = snapA.levels[startA.levelId].elevation
  const c0 = cellOf(startA.position, cs)
  const targetA = { i: c0.i - 4, j: c0.j + 3 }
  await A.page.evaluate((id) => window.__atlasPlayer.select(id), tokA.id)
  const from = await projectIn(A.page, "__atlasPlayer", {
    x: startA.position.x,
    y: elev + 0.5,
    z: startA.position.z,
  })
  const to = await projectIn(A.page, "__atlasPlayer", {
    x: (targetA.i + 0.5) * cs,
    y: elev,
    z: (targetA.j + 0.5) * cs,
  })
  await mouseDrag(A.page, from, to)
  await waitFor(
    A.page,
    ({ id, x, z }) => {
      const t = window.__atlasPlayer.client.getSnapshot().scene.tokens[id]
      return t && (t.position.x !== x || t.position.z !== z)
    },
    { id: tokA.id, ...startA.position },
    { label: "dragged token moved" }
  )
  const movedA = (await hostState(dm)).state.scene.tokens[tokA.id].position
  checks.eq(
    cellOf(movedA, cs),
    targetA,
    `drag: the host moved ${tokA.name} to the dropped cell`
  )
  const exploredBefore = count((await playerView(A.page)).masks[lvl].explored)

  // B: to the nearest closed door it can reach (the front door for Brunhild). The player's view reports
  // locked doors as "closed", so only doors the host knows are unlocked are offered.
  const hs = (await hostState(dm)).state
  const tB = hs.scene.tokens[tokB.id]
  const unlocked = Object.values(hs.scene.objects)
    .filter((o) => o.type === "door" && o.state === "closed")
    .map((o) => o.id)
  const door = await reachableDoor(B.page, tokB.id, unlocked)
  checks.ok(!!door, `a closed door ${tokB.name} can walk up to`, door)
  const doorCell = door.cell
  const mv = await requestMoveTo(B.page, tokB.id, doorCell)
  checks.ok(
    mv.reqId,
    `${B.name} plans a path to the door (${mv.steps} steps, ${mv.feet} ft)`,
    mv
  )
  const resB = await waitResult(B.page, mv.reqId)
  checks.ok(resB.ok, `move accepted by the host`, resB)
  for (const p of [A, B])
    checks.eq(
      await viewConverges(dm, p.page, p.uid),
      [],
      `${p.name}'s view equals the oracle after the moves`
    )
  await shot(A.page, OUT, "04-player-A-moved")

  // ---- door ------------------------------------------------------------------------------------------------
  checks.step(`${B.name} opens a door by clicking it`)
  await B.page.bringToFront()
  await B.page.evaluate((id) => window.__atlasPlayer.select(id), tokB.id)
  await sleep(300)
  await clickDoor(B.page, door, hs.scene.levels[tB.levelId].elevation)
  await waitFor(
    dm,
    (id) =>
      window.__atlasHost.runner.getSnapshot().state.scene.objects[id].state ===
      "open",
    door.id,
    { label: "door opened on the host", timeout: 8000 }
  ).then(
    () => checks.ok(true, "the host opened the door"),
    (e) => checks.fail("the host opened the door", e.message)
  )
  checks.eq(
    await viewConverges(dm, B.page, B.uid),
    [],
    `${B.name}'s view equals the oracle with the door open`
  )
  const vB2 = await playerView(B.page)
  const openedInView = Object.values(vB2.objects).find(
    (o) => o.type === "door" && o.id === door.id
  )
  checks.ok(
    openedInView?.state === "open",
    "the player's view shows the door open",
    openedInView
  )
  await sleep(800)
  await shot(B.page, OUT, "05-player-B-door-open")

  // ---- lock ----------------------------------------------------------------------------------------------
  checks.step("DM locks movement; a move is rejected")
  await dm.bringToFront()
  await dm.getByRole("tab", { name: /Table/ }).click()
  await dm.getByRole("switch", { name: /Lock all movement/ }).click()
  await waitFor(
    A.page,
    () =>
      window.__atlasPlayer.client.getSnapshot().view.flags.movementLocked ===
      true,
    null,
    { label: "locked flag reaches the player" }
  )
  const posLocked = (await hostState(dm)).state.scene.tokens[tokA.id].position
  const mvLocked = await requestMoveTo(A.page, tokA.id, {
    i: targetA.i + 1,
    j: targetA.j,
  })
  const resLocked = await waitResult(A.page, mvLocked.reqId)
  checks.ok(
    resLocked.ok === false &&
      /locked/.test(`${resLocked.reason} ${resLocked.local ?? ""}`),
    "the move is rejected as movement-locked",
    resLocked
  )
  checks.eq(
    (await hostState(dm)).state.scene.tokens[tokA.id].position,
    posLocked,
    "the token did not move on the host"
  )
  await sleep(500)
  await shot(A.page, OUT, "06-player-A-locked")

  // ---- reconnection ----------------------------------------------------------------------------------------
  checks.step(`${A.name} reloads and rejoins in the same state`)
  const beforeReload = await playerView(A.page)
  checks.ok(
    count(beforeReload.masks[lvl].explored) >= exploredBefore,
    "exploration kept growing while moving"
  )
  wire.A.push(...(await drainWire(A.page)))
  await A.page.reload({ waitUntil: "domcontentloaded" })
  await waitPlayerLive(A.page)
  await waitFor(
    A.page,
    (id) =>
      window.__atlasPlayer.client
        .getSnapshot()
        .view?.controlledTokenIds.includes(id),
    tokA.id,
    { label: "token after reload" }
  )
  const afterReload = await playerView(A.page)
  checks.eq(
    jsonDiff(beforeReload, afterReload),
    [],
    "after reload the view is identical (explored fog, memory, tokens, flags)"
  )
  checks.eq(
    afterReload.tokens[tokA.id].position,
    posLocked,
    "the token is where it was"
  )
  await sleep(1200)
  await shot(A.page, OUT, "07-player-A-reloaded")

  // ---- unlock + a final move so the rejoined client keeps working --------------------------------------------
  await dm.getByRole("switch", { name: /Lock all movement/ }).click()
  await waitFor(
    A.page,
    () =>
      window.__atlasPlayer.client.getSnapshot().view.flags.movementLocked ===
      false,
    null,
    { label: "unlocked" }
  )
  const mvAfter = await requestMoveTo(A.page, tokA.id, {
    i: targetA.i + 1,
    j: targetA.j - 1,
  })
  checks.ok(
    (await waitResult(A.page, mvAfter.reqId)).ok,
    "after rejoining, moves work again"
  )
  const movedAt = Date.now()
  for (const p of [A, B])
    checks.eq(
      await viewConverges(dm, p.page, p.uid),
      [],
      `${p.name}'s view equals the oracle at the end`
    )

  // ---- the DM's tab reloads: a new host run, players resync --------------------------------------------------
  checks.step("The DM reloads; the game resumes where it was")
  // Token moves are saved within ~1 s (a hard reload may lose the last second of play): wait until the
  // stored game has the token where the host has it.
  const saved = async () =>
    dm.evaluate(
      async ({ sid, tokenId }) => {
        const m = await import("/src/app/createServices.ts")
        const s = await m.createServices({ mode: "local" })
        const row = await s.sessions.loadSessionState(sid)
        const state = row?.content?.kind === "game" ? row.content.state : null
        const live = window.__atlasHost.runner.getSnapshot().state
        return (
          JSON.stringify(state?.scene.tokens[tokenId]?.position) ===
          JSON.stringify(live.scene.tokens[tokenId].position)
        )
      },
      { sid: sessionId, tokenId: tokA.id }
    )
  const tSave = Date.now()
  while (!(await saved()) && Date.now() - tSave < 8000) await sleep(200)
  checks.ok(
    await saved(),
    `the move was saved within ${((Date.now() - movedAt) / 1000).toFixed(1)} s of its result`
  )
  const beforeHost = {
    A: await playerView(A.page),
    B: await playerView(B.page),
  }
  const epochBefore = (await playerSnap(A.page)).epoch
  await dm.reload({ waitUntil: "domcontentloaded" })
  await waitHosting(dm, 60000)
  for (const p of [A, B]) {
    await waitFor(
      p.page,
      (epoch) => {
        const s = window.__atlasPlayer.client.getSnapshot()
        return s.status === "live" && s.epoch !== epoch
      },
      epochBefore,
      { timeout: 30000, label: `${p.name} follows the new host run` }
    )
    checks.eq(
      jsonDiff(beforeHost[p.key], await playerView(p.page)),
      [],
      `${p.name}: same view after the host restart (explored fog, memory, tokens)`
    )
  }
  const mvHost = await requestMoveTo(A.page, tokA.id, targetA)
  checks.ok(
    (await waitResult(A.page, mvHost.reqId)).ok,
    "moves work against the new host run"
  )

  // ---- leaks ---------------------------------------------------------------------------------------------
  checks.step("Nothing secret reached a player")
  wire.A.push(...(await drainWire(A.page)))
  wire.B.push(...(await drainWire(B.page)))
  const rows = await dm.evaluate(
    async ({ sid, uids }) => {
      const m = await import("/src/app/createServices.ts")
      const s = await m.createServices({ mode: "local" })
      const out = {}
      for (const uid of uids)
        out[uid] = JSON.stringify(await s.sessions.loadPlayerView(sid, uid))
      return out
    },
    { sid: sessionId, uids: [A.uid, B.uid] }
  )
  for (const p of [A, B]) {
    const frames = wire[p.key]
    const bytes = frames.reduce((n, f) => n + f.json.length, 0)
    const views = frames.filter((f) => f.name.includes(":view:"))
    checks.ok(
      views.length > 0,
      `${p.name}: captured ${frames.length} frames (${views.length} on the view topic, ${(bytes / 1024).toFixed(1)} KB)`
    )
    const foreign = frames.filter(
      (f) => /:view:|:req:/.test(f.name) && !f.name.endsWith(p.uid)
    )
    checks.eq(
      foreign.length,
      0,
      `${p.name} received nothing on another player's topics`
    )
    const texts = [
      ...frames.map((f, k) => ({
        where: `${f.name.split(":").slice(-2).join(":")}#${k}`,
        text: f.json,
      })),
      { where: "player_views row", text: rows[p.uid] ?? "" },
    ]
    const leaks = findLeaks(texts, secrets)
    checks.eq(
      leaks.slice(0, 5),
      [],
      `${p.name}: no hidden token / secret door / DM note / object name / asset id in any payload`
    )
  }
  if (process.env.ATLAS_KEEP_WIRE)
    fs.writeFileSync(`${OUT}/wire.json`, JSON.stringify(wire, null, 1))
  await shot(dm, OUT, "08-dm-end")
} catch (err) {
  checks.fail("multiplayer-local crashed", err)
} finally {
  const errors = seriousErrors(logs)
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 6).join("\n")
  )
  await browser.close()
  checks.done()
}
