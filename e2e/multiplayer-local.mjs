// Multiplayer end to end in local mode (?local=1: IndexedDB + BroadcastChannel between tabs of ONE
// browser context — BroadcastChannel does not cross contexts, so the three tabs share one context but
// have separate per-tab identities).
//
// DM opens a sample (or an .atlas.json) → starts a session → the host map's right-click menus (token,
// door, light) work before anyone has joined → two players join by room code → the DM
// assigns characters through the Players tab → players move (mouse drag and planner paths) → every
// player's view must equal the authoritative oracle (fresh vision engine + filter) → a player opens a
// door → the DM locks movement and a move is rejected → a player reloads and rejoins in the same state
// → a player climbs the stairs by dragging past the top step and comes back with "Go down" → the DM's
// tab reloads (a new host run) and both players resume in the same state → no hidden token,
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
  closeMenus,
  crashed,
  drainWire,
  expectedView,
  findLeaks,
  hostActiveLevel,
  hostContextMenu,
  hostMenuTargets,
  hostState,
  hoverSubmenu,
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
  walkToward,
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

  // ---- host map menus before anyone joins -------------------------------------------------------------
  checks.step("Host map menus work before any player has joined")
  // Base UI menu labels outside a group throw ("MenuGroupContext is missing"), which crashed the host
  // console into the error boundary (and sent every player to "Waiting for the DM").
  const menuLogs = logs.length
  const menuLevel = await hostActiveLevel(dm)
  const targets = await hostMenuTargets(dm, menuLevel)
  console.log(
    `  level ${scene0.levels[menuLevel].name}: ${targets.tokens.length} tokens, ${targets.doors.length} doors, ${targets.lights.length} lights on screen`
  )
  const menuToken = targets.tokens[0]
  checks.ok(!!menuToken, "a token is on screen", targets.tokens)
  if (menuToken) {
    checks.ok(
      await hostContextMenu(dm, menuToken),
      `right-clicking ${menuToken.name} opens its menu`
    )
    await hoverSubmenu(dm, "Move to level")
    checks.ok(
      (await dm.getByRole("menuitemcheckbox").count()) >=
        Object.keys(scene0.levels).length,
      "'Move to level' lists every level"
    )
    // Reopen: the open submenu's positioner covers the next trigger.
    await hostContextMenu(dm, menuToken)
    await hoverSubmenu(dm, "Controlled by")
    checks.ok(
      await dm.getByText("No players have joined yet").isVisible(),
      "'Controlled by' says no players have joined yet"
    )
    checks.ok(!(await crashed(dm)), "the host console did not crash")
    await closeMenus(dm)
  }
  let doorMenu = false
  for (const d of targets.doors.slice(0, 6)) {
    if (!(await hostContextMenu(dm, d))) continue
    doorMenu = await dm
      .getByRole("menuitem", { name: /^(Open|Close)/ })
      .first()
      .isVisible()
    if (doorMenu) break
  }
  checks.ok(doorMenu, "right-clicking a door opens the door menu")
  await closeMenus(dm)
  let lightToggled = null
  for (const l of targets.lights.slice(0, 8)) {
    if (!(await hostContextMenu(dm, l))) continue
    const toggle = dm.getByRole("menuitem", { name: /Put out|Light it/ })
    if (!(await toggle.isVisible())) continue
    const on = await dm.evaluate(
      (id) =>
        window.__atlasHost.runner.getSnapshot().state.scene.objects[id].on,
      l.id
    )
    await toggle.click()
    await waitFor(
      dm,
      ({ id, on }) =>
        window.__atlasHost.runner.getSnapshot().state.scene.objects[id].on !==
        on,
      { id: l.id, on },
      { timeout: 5000, label: "light toggled" }
    ).then(
      () => (lightToggled = l),
      () => (lightToggled = false)
    )
    if (lightToggled) {
      // Switch it back so the rest of the run plays the scene as authored.
      await hostContextMenu(dm, l)
      await dm.getByRole("menuitem", { name: /Put out|Light it/ }).click()
      await waitFor(
        dm,
        ({ id, on }) =>
          window.__atlasHost.runner.getSnapshot().state.scene.objects[id].on ===
          on,
        { id: l.id, on },
        { timeout: 5000, label: "light restored" }
      )
    }
    break
  }
  checks.ok(
    !!lightToggled,
    `a light's menu switches it off and on (${lightToggled?.name ?? lightToggled?.id ?? "none"})`
  )
  await closeMenus(dm)
  checks.ok(
    !(await crashed(dm)) &&
      (await hostState(dm)).status === "hosting" &&
      logs.slice(menuLogs).every((l) => !/MenuGroupContext/.test(l)),
    "the host is still hosting, with no menu errors",
    logs.slice(menuLogs).filter((l) => /MenuGroupContext/.test(l))
  )

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
  if (menuToken) {
    await dm.bringToFront()
    await hostContextMenu(dm, menuToken)
    await hoverSubmenu(dm, "Controlled by")
    const listed = []
    for (const n of [A.name, B.name])
      if (
        await dm.getByRole("menuitemcheckbox", { name: n }).first().isVisible()
      )
        listed.push(n)
    checks.eq(listed, [A.name, B.name], "'Controlled by' lists both players")
    await closeMenus(dm)
    await sleep(300)
    const statuses = await Promise.all(
      [A, B].map((p) =>
        p.page.evaluate(() => window.__atlasPlayer.client.getSnapshot().status)
      )
    )
    checks.eq(
      statuses,
      ["live", "live"],
      "both players stay live while the DM uses the menus"
    )
  }

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

  // ---- stairs ------------------------------------------------------------------------------------------------
  // A drag to the cell just beyond a staircase's top edge must climb it even when the lower level has known
  // floor there (the usual layout: stairs inside a room); the HUD then offers "Go down" on the landing.
  const stairs = Object.values(hs.scene.objects).find(
    (o) =>
      o.type === "connector" &&
      o.style === "stairs" &&
      o.levelId === tB.levelId &&
      hs.scene.levels[o.toLevelId]
  )
  if (stairs) {
    checks.step(`${B.name} climbs the stairs by dragging past the top step`)
    const r = stairs.rect
    const i0 = Math.round(r.x / cs)
    const i1 = Math.round((r.x + r.w) / cs) - 1
    const j0 = Math.round(r.z / cs)
    const j1 = Math.round((r.z + r.d) / cs) - 1
    // Ascending direction: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X.
    const [bottom, beyond] = {
      0: [
        { i: i0, j: j0 },
        { i: i0, j: j1 + 1 },
      ],
      1: [
        { i: i0, j: j0 },
        { i: i1 + 1, j: j0 },
      ],
      2: [
        { i: i0, j: j1 },
        { i: i0, j: j0 - 1 },
      ],
      3: [
        { i: i1, j: j0 },
        { i: i0 - 1, j: j0 },
      ],
    }[stairs.direction]
    await B.page.bringToFront()
    // First explore the landing cell's lower-level floor, from the cell one further along (a plan to the
    // landing cell itself would already go up): that is the case where a drag used to path around the
    // stairs on the lower level instead of climbing.
    const fwd = [
      { i: 0, j: 1 },
      { i: 1, j: 0 },
      { i: 0, j: -1 },
      { i: -1, j: 0 },
    ][stairs.direction]
    const past = { i: beyond.i + fwd.i, j: beyond.j + fwd.j }
    // (Getting next to it is enough; the check below is that the landing cell got explored.)
    await walkToward(B.page, tokB.id, past)
    let toBottom = await requestMoveTo(B.page, tokB.id, bottom)
    if (!toBottom.reqId) {
      // The staircase is behind closed doors the player has not opened (the Vineyard's manor hall): the
      // planner only paths through known, open space. The DM opens the level's closed doors (a DM play
      // control) and the player walks on.
      const opened = await dm.evaluate((levelId) => {
        const runner = window.__atlasHost.runner
        const objects = runner.getSnapshot().state.scene.objects
        const ids = Object.values(objects)
          .filter(
            (o) =>
              o.type === "door" &&
              o.levelId === levelId &&
              o.state === "closed" &&
              o.style !== "secret"
          )
          .map((o) => o.id)
        for (const doorId of ids)
          runner.dispatch({ t: "set-door", doorId, state: "open" })
        return ids.length
      }, tB.levelId)
      console.log(
        `  (the stairs are out of reach: the DM opened ${opened} closed doors)`
      )
      await sleep(600)
      await walkToward(B.page, tokB.id, past, 10)
      toBottom = await requestMoveTo(B.page, tokB.id, bottom)
    }
    const atBottom = toBottom.reqId
      ? await waitResult(B.page, toBottom.reqId)
      : null
    checks.ok(
      atBottom?.ok,
      `${B.name} walks to the foot of the stairs (${toBottom.steps} steps)`,
      atBottom ?? toBottom
    )
    if (atBottom?.ok) {
      const lower = tB.levelId
      const knownBeyond = await B.page.evaluate(
        async ({ lower, c }) => {
          const { decodeMask, cellTouched } =
            await import("/src/core/vision/mask.ts")
          const ex =
            window.__atlasPlayer.client.getSnapshot().view.masks[lower]
              ?.explored
          return ex ? cellTouched(decodeMask(ex), c.j * ex.width + c.i) : false
        },
        { lower, c: beyond }
      )
      checks.ok(
        knownBeyond,
        `the landing cell ${beyond.i},${beyond.j} is known floor on the lower level too`
      )
      // Whether the player knows the upper storey's floor at the landing. Seen from the foot of the
      // stairs it depends on the stairwell (the Crooked Lantern's is visible; the Vineyard manor's
      // upper slab hides it). A drop there climbs only onto known floor, so if it is unknown the token
      // first walks up the run to the top step, where its view level switches to the upper storey.
      const upperGround = (c) =>
        B.page.evaluate(
          async ({ level, c, cs }) => {
            const { hasGroundAt } = await import("/src/core/scene/queries.ts")
            const scene = window.__atlasPlayer.client.getSnapshot().scene
            return (
              !!scene.levels[level] &&
              hasGroundAt(scene, level, {
                x: (c.i + 0.5) * cs,
                z: (c.j + 0.5) * cs,
              })
            )
          },
          { level: stairs.toLevelId, c, cs }
        )
      if (!(await upperGround(beyond))) {
        const top = { i: beyond.i - fwd.i, j: beyond.j - fwd.j }
        const toTop = await requestMoveTo(B.page, tokB.id, top)
        const atTop = toTop.reqId ? await waitResult(B.page, toTop.reqId) : null
        checks.ok(
          atTop?.ok,
          `the upper landing is not visible from the foot: ${B.name} walks up to the top step`,
          atTop ?? toTop
        )
        await sleep(600)
        checks.ok(
          await upperGround(beyond),
          `from the top step, the upper landing is known floor`
        )
      }
      await B.page.evaluate((id) => window.__atlasPlayer.select(id), tokB.id)
      await sleep(300)
      // Drag from the token (standing on the run's ground) to the landing, projected on the plane of
      // the player's view level (where the drop is picked).
      const at = await B.page.evaluate(
        async ({ id }) => {
          const { groundHeightAt, tokenViewLevelId } =
            await import("/src/core/scene/queries.ts")
          const scene = window.__atlasPlayer.client.getSnapshot().scene
          const tok = scene.tokens[id]
          const view = tokenViewLevelId(scene, tok)
          return {
            ground: groundHeightAt(scene, tok.levelId, tok.position),
            dropY: scene.levels[view].elevation,
            x: tok.position.x,
            z: tok.position.z,
          }
        },
        { id: tokB.id }
      )
      const from = await projectIn(B.page, "__atlasPlayer", {
        x: at.x,
        y: at.ground + 1,
        z: at.z,
      })
      const to = await projectIn(B.page, "__atlasPlayer", {
        x: (beyond.i + 0.5) * cs,
        y: at.dropY,
        z: (beyond.j + 0.5) * cs,
      })
      await mouseDrag(B.page, from, to)
      await waitFor(
        dm,
        ({ id, level }) =>
          window.__atlasHost.runner.getSnapshot().state.scene.tokens[id]
            .levelId === level,
        { id: tokB.id, level: stairs.toLevelId },
        { timeout: 8000, label: "token upstairs" }
      ).catch(() => {})
      const up = (await hostState(dm)).state.scene.tokens[tokB.id]
      checks.ok(
        up.levelId === stairs.toLevelId &&
          JSON.stringify(cellOf(up.position, cs)) === JSON.stringify(beyond),
        `the drag climbs to ${hs.scene.levels[stairs.toLevelId].name}`,
        { levelId: up.levelId, cell: cellOf(up.position, cs) }
      )
      const goDown = B.page.getByRole("button", { name: /^Go down/ })
      await goDown
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
      if (await goDown.first().isVisible()) {
        await goDown.first().click()
        await waitFor(
          dm,
          ({ id, level }) =>
            window.__atlasHost.runner.getSnapshot().state.scene.tokens[id]
              .levelId === level,
          { id: tokB.id, level: lower },
          { timeout: 8000, label: "token downstairs" }
        ).catch(() => {})
      }
      checks.eq(
        (await hostState(dm)).state.scene.tokens[tokB.id].levelId,
        lower,
        "on the landing, the HUD's Go down takes it back down"
      )
      checks.eq(
        await viewConverges(dm, B.page, B.uid),
        [],
        `${B.name}'s view equals the oracle after the stairs`
      )
    }
  }
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
      async ({ sid, tokenIds }) => {
        const m = await import("/src/app/createServices.ts")
        const s = await m.createServices({ mode: "local" })
        const row = await s.sessions.loadSessionState(sid)
        const state = row?.content?.kind === "game" ? row.content.state : null
        const live = window.__atlasHost.runner.getSnapshot().state
        const where = (t) => JSON.stringify([t?.levelId, t?.position])
        return tokenIds.every(
          (id) =>
            where(state?.scene.tokens[id]) === where(live.scene.tokens[id])
        )
      },
      { sid: sessionId, tokenIds: [tokA.id, tokB.id] }
    )
  const tSave = Date.now()
  while (!(await saved()) && Date.now() - tSave < 8000) await sleep(200)
  checks.ok(
    await saved(),
    `the moves were saved within ${((Date.now() - movedAt) / 1000).toFixed(1)} s of their results`
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
