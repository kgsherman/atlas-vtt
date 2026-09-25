// Changing the scene mid-session end to end in local mode (?local=1), through the DM's "Change scene"
// dialog.
//
// DM starts a copy of The Crooked Lantern in a new world → players A and B join and get a character
// each; the DM tracks A's hit points and conditions, A says something in the chat → the DM moves the
// game to a copy of the Stress Test sample (Sample scenes → "Use a copy", added to the world), bringing
// the party: the room code, the players, their characters (hit points and conditions included) and the
// chat stay; the chat gains the travel notice; every player's view equals the oracle on the new scene,
// A's page says where the party went and A's character walks there → the DM moves the game back to The
// Crooked Lantern (listed among the world's scenes) with only A's character: the scene holds the same
// token ids (the character replaces its own twin), B's character stays behind, so B controls nothing
// and is told the DM moved the game → A and then the DM reload and both come back on that scene → no
// player ever received a secret of any of the scenes, or another player's id.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/change-map-local.mjs
import {
  Checks,
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
  drainWire,
  findLeaks,
  hostState,
  joinGame,
  openSceneInEditor,
  playerView,
  sceneSecrets,
  startSession,
  viewConverges,
  waitHosting,
  waitPlayerLive,
  waitResult,
} from "./session.mjs"

const OUT = outDir("change-map-local")
const checks = new Checks("change-map-local")
const logs = []
const browser = await openBrowser()

/** Wait until the host plays the scene named `name` (after `serial` scene changes). */
async function waitMap(dm, name, serial, timeout = 60000) {
  await waitFor(
    dm,
    ({ name, serial }) => {
      const s = window.__atlasHost?.runner.getSnapshot().state
      return s?.scene.name === name && (s.mapSerial ?? 0) === serial
    },
    { name, serial },
    { timeout, label: `the host plays ${name}` }
  )
}

/** Wait until a player's page shows the view of the `serial`-th scene. */
async function waitPlayerMap(page, serial, timeout = 30000) {
  await waitFor(
    page,
    (serial) =>
      (window.__atlasPlayer?.client.getSnapshot().view?.scene.mapSerial ??
        0) === serial,
    serial,
    { timeout, label: `player on scene ${serial}` }
  )
}

/** A move of a player's token to a square next to it that its planner can reach; returns the result. */
async function stepAside(page, tokenId) {
  const req = await page.evaluate((tokenId) => {
    const p = window.__atlasPlayer
    const scene = p.client.getSnapshot().scene
    const t = scene.tokens[tokenId]
    const cs = scene.grid.cellSize
    const i0 = Math.floor(t.position.x / cs)
    const j0 = Math.floor(t.position.z / cs)
    for (let r = 1; r <= 3; r++)
      for (let di = -r; di <= r; di++)
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const cell = { i: i0 + di, j: j0 + dj }
          const plan = p.planner.plan(tokenId, cell, t.levelId)
          if (plan?.path && plan.path.at(-1).levelId === t.levelId)
            return { reqId: p.client.requestMove(tokenId, plan.path), cell }
        }
    return null
  }, tokenId)
  if (!req) return { ok: false, reason: "no reachable square" }
  return { ...(await waitResult(page, req.reqId)), cell: req.cell }
}

/** Open the DM's Change scene dialog. */
async function openChangeScene(dm) {
  await dm.bringToFront()
  await dm.getByRole("button", { name: "Change scene" }).click()
  const dialog = dm.getByRole("dialog", { name: "Change scene" })
  await dialog.waitFor({ timeout: 10000 })
  return dialog
}

/** Step 3 → "Change scene"; waits until the dialog has closed. */
async function confirmChange(dm, dialog, name) {
  await dialog.getByRole("button", { name: "Review" }).click()
  await dialog.getByText(`Step 3 of 3 · Move the game to “${name}”?`).waitFor()
  await shot(dm, OUT, `confirm-${name.replace(/\W+/g, "-")}`)
  await dialog
    .getByRole("button", { name: "Change scene", exact: true })
    .click()
  await dialog.waitFor({ state: "hidden", timeout: 60000 })
}

/** An object with its keys sorted (for comparisons). */
const sorted = (o) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))

/** Starts watching a page for a toast; resolves whether it showed within `timeout`. */
const toastSeen = (page, text, timeout = 60000) =>
  page
    .locator("[data-sonner-toast]", { hasText: text })
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false)

const tableTexts = (state) =>
  (state.table?.log ?? []).map((m) => `${m.kind}:${m.text}`)

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })

  // ---- setup ------------------------------------------------------------------------------------------
  checks.step(
    "DM hosts The Crooked Lantern, two players join and get characters"
  )
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)
  await openSceneInEditor(dm, { mode: "local" })
  const h0 = await startSession(dm)
  const lantern = h0.state.scene
  const lanternRow = h0.state.origin?.sceneId
  checks.ok(typeof lanternRow === "string", "the game knows its saved scene")
  const pcs = Object.values(lantern.tokens)
    .filter((t) => t.kind === "pc" && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
  checks.ok(pcs.length >= 2, "the sample has two PCs")
  const A = await joinGame(context, {
    roomCode: h0.roomCode,
    name: "Aerin",
    capture: true,
    logs,
  })
  const B = await joinGame(context, {
    roomCode: h0.roomCode,
    name: "Bram",
    capture: true,
    logs,
  })
  const hero = pcs[0]
  const mate = pcs[1]
  await assignToken(dm, A, hero)
  await assignToken(dm, B, mate)
  const wire = { A: [], B: [] }
  const drain = async () => {
    wire.A.push(...(await drainWire(A.page)))
    wire.B.push(...(await drainWire(B.page)))
  }
  const hp = { current: 17, max: 23, temp: 2 }
  await dm.evaluate(
    ({ id, hp }) =>
      window.__atlasHost.runner.dispatch({
        t: "set-token-status",
        tokenId: id,
        hp,
        conditions: ["poisoned", "prone"],
      }),
    { id: hero.id, hp }
  )
  await A.page.evaluate(() =>
    window.__atlasPlayer.client.say("Onward, to the next scene!", "all")
  )
  await waitFor(
    dm,
    () =>
      (window.__atlasHost.runner.getSnapshot().state.table?.log ?? []).some(
        (m) => m.text === "Onward, to the next scene!"
      ),
    null,
    { timeout: 10000, label: "A's message reaches the host" }
  )
  const before = (await hostState(dm)).state
  const heroBefore = before.scene.tokens[hero.id]

  // ---- to a copy of the Stress Test, with the party ------------------------------------------------
  checks.step(
    "The DM moves the game to a copy of the Stress Test, bringing the party"
  )
  let dialog = await openChangeScene(dm)
  await shot(dm, OUT, "01-dialog-scenes")
  checks.ok(
    await dialog
      .getByRole("button", { name: "The Crooked Lantern (the current scene)" })
      .isDisabled(),
    "the scene being played is marked and can't be picked"
  )
  await dialog.getByRole("button", { name: "Sample scenes" }).click()
  await dialog
    .locator("[data-slot=card]", { hasText: "Stress Test" })
    .getByRole("button", { name: "Use a copy" })
    .click()
  await dialog
    .getByText("Step 2 of 3 · Who comes along to “Stress Test”", {
      exact: false,
    })
    .waitFor({ timeout: 60000 })
  const ticked = async (t) =>
    dialog.getByRole("checkbox", { name: t.name, exact: true }).isChecked()
  checks.ok(
    (await ticked(hero)) && (await ticked(mate)),
    "the players' characters come along by default"
  )
  await shot(dm, OUT, "02-dialog-party")
  const aToast = toastSeen(A.page, "The party travels to Stress Test")
  await confirmChange(dm, dialog, "Stress Test")
  await waitMap(dm, "Stress Test", 1)
  const h1 = await hostState(dm)
  const stress = h1.state.scene
  const carried = pcs.map((t) => t.id)
  checks.eq(h1.roomCode, h0.roomCode, "the room code is the same")
  checks.ok(
    carried.every((id) => Object.hasOwn(stress.tokens, id)),
    "the party stands on the new scene under the same ids"
  )
  const heroNow = stress.tokens[hero.id]
  checks.eq(
    { hp: heroNow.hp, conditions: heroNow.conditions },
    { hp, conditions: heroBefore.conditions },
    "A's character keeps its hit points and conditions"
  )
  checks.eq(
    { ...heroNow, levelId: null, position: null },
    { ...heroBefore, levelId: null, position: null },
    "A's character is copied whole (only its place changed)"
  )
  checks.eq(
    sorted(h1.state.owners),
    sorted({ [hero.id]: [A.uid], [mate.id]: [B.uid] }),
    "the players still control their characters"
  )
  checks.ok(
    Object.values(lantern.tokens)
      .filter((t) => !carried.includes(t.id))
      .every((t) => !Object.hasOwn(stress.tokens, t.id)),
    "the tokens left behind are not on the new scene"
  )
  const log1 = tableTexts(h1.state)
  checks.ok(
    log1.includes("chat:Onward, to the next scene!") &&
      log1.at(-1) === "system:The party travels to Stress Test",
    "the chat is kept and ends with the travel notice",
    log1.slice(-3)
  )
  checks.ok(
    h1.state.origin?.sceneId !== lanternRow && h1.state.origin?.dirty === false,
    "the game's saved scene is the new copy",
    h1.state.origin
  )

  checks.step("The players follow their characters")
  for (const P of [A, B]) {
    await waitPlayerMap(P.page, 1)
    checks.eq(
      await viewConverges(dm, P.page, P.uid, 20000),
      [],
      `${P.name}'s view equals the oracle on the new scene`
    )
  }
  checks.ok(await aToast, "A's page says where the party went")
  checks.eq(
    await A.page.evaluate(() => {
      const s = window.__atlasPlayer.client.getSnapshot()
      return { changes: s.mapChanges, controls: s.view.controlledTokenIds }
    }),
    { changes: 1, controls: [hero.id] },
    "A's client counted one scene change and controls its character"
  )
  await sleep(1500)
  await shot(A.page, OUT, "03-player-arrived")
  await shot(dm, OUT, "04-dm-arrived")
  const step1 = await stepAside(A.page, hero.id)
  checks.ok(step1.ok, "A's character walks on the new scene", step1)
  const moved = (await hostState(dm)).state.scene.tokens[hero.id].position
  checks.ok(
    Math.floor(moved.x / stress.grid.cellSize) === step1.cell?.i &&
      Math.floor(moved.z / stress.grid.cellSize) === step1.cell?.j,
    "the host moved it there",
    { moved, cell: step1.cell }
  )

  // ---- back to The Crooked Lantern, with A's character only ------------------------------------------
  checks.step(
    "Back to The Crooked Lantern with only A's character (same token ids)"
  )
  await drain()
  dialog = await openChangeScene(dm)
  await dialog
    .getByRole("button", { name: "Move the game to The Crooked Lantern" })
    .click()
  await dialog
    .getByText("Step 2 of 3 · Who comes along to “The Crooked Lantern”", {
      exact: false,
    })
    .waitFor({ timeout: 60000 })
  await dialog.getByRole("button", { name: "None", exact: true }).click()
  await dialog.getByRole("checkbox", { name: hero.name, exact: true }).click()
  checks.ok(
    (await ticked(hero)) && !(await ticked(mate)),
    "only A's character is ticked"
  )
  const bToast = toastSeen(
    B.page,
    "The DM moved the game to The Crooked Lantern"
  )
  await confirmChange(dm, dialog, "The Crooked Lantern")
  await waitMap(dm, "The Crooked Lantern", 2)
  const h2 = await hostState(dm)
  const back = h2.state.scene
  checks.eq(
    back.tokens[hero.id]?.hp,
    hp,
    "A's character replaced its twin of the saved scene (hit points kept)"
  )
  checks.eq(
    back.tokens[mate.id]?.position,
    lantern.tokens[mate.id].position,
    "B's character's twin stands where the saved scene has it"
  )
  checks.eq(
    h2.state.owners,
    { [hero.id]: [A.uid] },
    "only the character that came along keeps its player"
  )
  checks.eq(
    h2.state.origin?.sceneId,
    lanternRow,
    "the game is on its first saved scene again"
  )
  checks.eq(
    tableTexts(h2.state).at(-1),
    "system:The party travels to The Crooked Lantern",
    "the chat has the second notice"
  )
  await waitPlayerMap(A.page, 2)
  await waitPlayerMap(B.page, 2)
  checks.eq(
    await B.page.evaluate(
      () => window.__atlasPlayer.client.getSnapshot().view.controlledTokenIds
    ),
    [],
    "B controls nothing on this scene"
  )
  checks.ok(await bToast, "B's page says the DM moved the game")
  for (const P of [A, B])
    checks.eq(
      await viewConverges(dm, P.page, P.uid, 20000),
      [],
      `${P.name}'s view equals the oracle`
    )
  await shot(B.page, OUT, "05-player-left-behind")

  // ---- reloads ------------------------------------------------------------------------------------------
  checks.step("A and then the DM reload: both come back on this scene")
  await drain()
  await A.page.reload({ waitUntil: "domcontentloaded" })
  await waitPlayerLive(A.page, 45000)
  await waitPlayerMap(A.page, 2)
  checks.eq(
    await viewConverges(dm, A.page, A.uid, 20000),
    [],
    "A's view equals the oracle after the reload"
  )
  await dm.reload({ waitUntil: "domcontentloaded" })
  await waitHosting(dm, 90000)
  const h3 = await hostState(dm)
  checks.eq(
    {
      name: h3.state.scene.name,
      serial: h3.state.mapSerial,
      owners: h3.state.owners,
      hp: h3.state.scene.tokens[hero.id]?.hp,
    },
    {
      name: "The Crooked Lantern",
      serial: 2,
      owners: { [hero.id]: [A.uid] },
      hp,
    },
    "the DM's reload resumes the game on this scene"
  )
  for (const P of [A, B]) {
    await waitPlayerLive(P.page, 45000)
    checks.eq(
      await viewConverges(dm, P.page, P.uid, 20000),
      [],
      `${P.name}'s view equals the oracle after the DM's reload`
    )
  }
  const aView = await playerView(A.page)
  checks.ok(
    aView.scene.mapSerial === 2 && aView.tokens[hero.id] !== undefined,
    "A still sees its character"
  )

  // ---- leaks -------------------------------------------------------------------------------------------------
  checks.step(
    "No player received a secret of any scene, or another player's id"
  )
  await drain()
  const secrets = [lantern, stress, back].map(sceneSecrets)
  const all = {
    ids: [...new Set(secrets.flatMap((s) => s.ids))],
    strings: [...new Set(secrets.flatMap((s) => s.strings))],
  }
  // A carried character is public on the scene it came from and the one it went to.
  const texts = (who) =>
    wire[who].map((f, k) => ({ where: `${who} ${f.name} #${k}`, text: f.json }))
  const views = (who) => texts(who).filter((f) => f.where.includes(":view:"))
  checks.ok(
    views("A").some((f) => f.text.includes("The party travels to Stress Test")),
    "the scan saw the travel notice on A's wire (positive control)"
  )
  checks.eq(findLeaks(texts("A"), all), [], "A never received a secret")
  checks.eq(findLeaks(texts("B"), all), [], "B never received a secret")
  checks.eq(
    findLeaks(views("A"), { ids: [B.uid], strings: [] }),
    [],
    "A's views never hold B's id"
  )
  checks.eq(
    findLeaks(views("B"), { ids: [A.uid], strings: [] }),
    [],
    "B's views never hold A's id"
  )
  checks.eq(seriousErrors(logs), [], "no console errors")
} catch (err) {
  checks.fail("unexpected error", err)
} finally {
  await browser.close()
  if (logs.length) console.log(`\n${logs.slice(0, 40).join("\n")}`)
  checks.done()
}
