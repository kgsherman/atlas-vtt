// The table end to end in local mode (?local=1): chat, whispers, host-rolled dice, combat and pings
// between the DM and two players, through the real UI (dock, quick dice, slash commands, the Combat
// tab, the initiative order, long presses on the map).
//
// DM starts The Crooked Lantern → players A and B join and get a character each → A chats and rolls
// a quick d20; B whispers to the DM; the DM rolls in secret and whispers to B by name → each player's
// log holds exactly what they may read, and every roll equals the host's → the DM starts combat with
// everyone on the level (the hidden Bandit Lookout included), rolls for the NPCs and begins → the
// order players see holds only combatants they can see → A rolls initiative from the order, gets the
// turn and ends it → A pings with a long press (B and the DM see it), the DM pings with Shift (B's
// camera goes there) → B reloads and the log and order come back → no whisper, secret roll, hidden
// combatant or other player's id ever reached the wrong player (every BroadcastChannel frame and the
// stored player_views rows).
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/table-local.mjs
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
} from "./session.mjs"

const OUT = outDir("table-local")
const checks = new Checks("table-local")
const logs = []
const browser = await openBrowser()

const log = (view) =>
  Object.values(view?.table?.log ?? {}).sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)
  )
const texts = (view) => log(view).map((m) => m.text)

/** Type into a page's chat dock (opened with Enter from the map when closed). */
async function chat(page, line) {
  const input = page.getByRole("textbox", { name: "Message" })
  if (!(await input.isVisible())) {
    await page.locator("canvas").first().focus()
    await page.keyboard.press("Enter")
    await input.waitFor({ timeout: 5000 })
  }
  await input.fill(line)
  await input.press("Enter")
}

/** Collect pings a player page receives (client.onPing), for the test to read. */
async function recordPings(page) {
  await page.evaluate(() => {
    window.__pings = []
    window.__atlasPlayer.client.onPing((p) => window.__pings.push(p))
  })
}

/** Hold the left button still at a canvas point long enough to ping (LONG_PRESS_MS = 450). */
async function longPress(page, x, y, { shift = false } = {}) {
  const box = await page.locator("canvas").first().boundingBox()
  await page.mouse.move(box.x + x, box.y + y)
  if (shift) await page.keyboard.down("Shift")
  await page.mouse.down()
  await sleep(750)
  await page.mouse.up()
  if (shift) await page.keyboard.up("Shift")
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })

  // ---- setup ------------------------------------------------------------------------------------------
  checks.step("DM hosts, two players join and get characters")
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)
  await openSceneInEditor(dm, { mode: "local" })
  const h0 = await startSession(dm)
  const scene = h0.state.scene
  const secrets = sceneSecrets(scene)
  const pcs = Object.values(scene.tokens)
    .filter((t) => t.kind === "pc" && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
  const hidden = Object.values(scene.tokens).filter((t) => t.hidden)
  checks.ok(
    pcs.length >= 2 && hidden.length >= 1,
    "the sample has two PCs and a hidden token",
    { pcs: pcs.length, hidden: hidden.length }
  )
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
  await assignToken(dm, A, pcs[0])
  await assignToken(dm, B, pcs[1])
  await recordPings(A.page)
  await recordPings(B.page)
  const wire = { A: [], B: [] }
  const drain = async () => {
    wire.A.push(...(await drainWire(A.page)))
    wire.B.push(...(await drainWire(B.page)))
  }

  // ---- chat and dice -------------------------------------------------------------------------------------
  checks.step("Chat, whispers and rolls reach exactly their readers")
  await A.page.bringToFront()
  await chat(A.page, "Hello from Aerin")
  await A.page.getByRole("button", { name: "Roll a d20" }).click()
  await B.page.bringToFront()
  await chat(B.page, "/w SENTINEL_WHISPER_TO_DM")
  await dm.bringToFront()
  await chat(dm, "/gr 1d20+3 SENTINEL_SECRET_ROLL")
  await chat(dm, "/w Bram SENTINEL_FOR_BRAM")
  await chat(dm, "Roll for initiative!")
  await waitFor(
    B.page,
    () =>
      Object.values(
        window.__atlasPlayer.client.getSnapshot().view?.table?.log ?? {}
      ).some((m) => m.text === "Roll for initiative!"),
    null,
    { timeout: 15000, label: "B has the DM's last message" }
  )
  await waitFor(
    A.page,
    () =>
      Object.values(
        window.__atlasPlayer.client.getSnapshot().view?.table?.log ?? {}
      ).some((m) => m.text === "Roll for initiative!"),
    null,
    { timeout: 15000, label: "A has the DM's last message" }
  )
  const va = await playerView(A.page)
  const vb = await playerView(B.page)
  checks.eq(
    texts(va),
    ["Hello from Aerin", "", "Roll for initiative!"],
    "A reads: its chat, its d20, the DM's public line"
  )
  checks.eq(
    texts(vb),
    [
      "Hello from Aerin",
      "",
      "SENTINEL_WHISPER_TO_DM",
      "SENTINEL_FOR_BRAM",
      "Roll for initiative!",
    ],
    "B reads: A's chat and roll, its own whisper, the DM's whisper to it"
  )
  const hostLog = (await hostState(dm)).state.table.log
  checks.eq(hostLog.length, 6, "the DM's log holds all six messages")
  const hostRoll = hostLog.find((m) => m.kind === "roll" && m.from !== null)
  const aRoll = log(va).find((m) => m.kind === "roll")
  checks.ok(
    aRoll &&
      hostRoll &&
      aRoll.roll.total === hostRoll.roll.total &&
      aRoll.roll.total >= 1 &&
      aRoll.roll.total <= 20,
    "A's d20 is the host's roll",
    { player: aRoll?.roll, host: hostRoll?.roll }
  )
  const secret = hostLog.find((m) => m.text === "SENTINEL_SECRET_ROLL")
  checks.ok(
    secret && Array.isArray(secret.to) && secret.to.length === 0,
    "the DM's /gr roll is secret (no reader)"
  )
  checks.ok(
    log(vb).find((m) => m.text === "SENTINEL_FOR_BRAM")?.whisper === true &&
      log(vb).find((m) => m.text === "SENTINEL_WHISPER_TO_DM")?.mine === true,
    "whispers are marked as such on B's side"
  )
  await shot(B.page, OUT, "01-b-chat")

  // ---- combat ---------------------------------------------------------------------------------------------
  checks.step("Combat: the DM starts it; players see only who they can see")
  await dm.bringToFront()
  await dm.getByRole("tab", { name: /Combat/ }).click()
  await dm.getByRole("button", { name: /Everyone on this level/ }).click()
  await dm.getByRole("button", { name: /Roll for NPCs/ }).click()
  const combat0 = (await hostState(dm)).state.table.combat
  const onLevel = Object.values(scene.tokens).filter(
    (t) => t.levelId === pcs[0].levelId
  )
  checks.eq(
    combat0.entries.length,
    onLevel.length,
    "every token on the level joined"
  )
  const hiddenEntry = combat0.entries.find((e) =>
    hidden.some((t) => t.id === e.tokenId)
  )
  checks.ok(
    hiddenEntry !== undefined,
    "the hidden token is in the DM's order (players are never sent it)"
  )
  await dm.getByRole("button", { name: /Begin/ }).click()
  await sleep(1500)
  const ca = (await playerView(A.page)).table?.combat
  const seenByA = new Set([...Object.keys((await playerView(A.page)).tokens)])
  checks.ok(
    ca &&
      ca.entries.length > 0 &&
      ca.entries.every((e) => e.tokenId === null || seenByA.has(e.tokenId)),
    "A's order holds only tokens in A's view",
    ca?.entries
  )
  checks.ok(
    !ca?.entries.some((e) => hidden.some((t) => t.id === e.tokenId)),
    "the hidden token is not in A's order"
  )
  await shot(dm, OUT, "02-dm-combat")

  checks.step("A rolls initiative and takes, then ends, its turn")
  await A.page.bringToFront()
  await A.page
    .getByRole("button", { name: new RegExp(`Roll initiative for`) })
    .first()
    .click()
  await A.page.getByLabel("Initiative bonus").fill("2")
  await A.page.getByRole("button", { name: "Roll", exact: true }).last().click()
  await waitFor(
    dm,
    (id) =>
      window.__atlasHost.runner
        .getSnapshot()
        .state.table.combat.entries.find((e) => e.tokenId === id)?.initiative !=
      null,
    pcs[0].id,
    { timeout: 15000, label: "A's initiative on the host" }
  )
  const aEntry = (await hostState(dm)).state.table.combat.entries.find(
    (e) => e.tokenId === pcs[0].id
  )
  checks.ok(
    aEntry.initiative >= 3 && aEntry.initiative <= 22,
    "A's initiative is 1d20 + 2",
    aEntry.initiative
  )
  await dm.bringToFront()
  await dm
    .locator(`li[data-entry="${aEntry.id}"]`)
    .getByRole("button", { name: "Make it their turn" })
    .click()
  await A.page.bringToFront()
  const endTurn = A.page.getByRole("button", { name: "End turn" })
  await endTurn.waitFor({ timeout: 15000 })
  checks.ok(true, "A sees End turn on its own turn")
  await endTurn.click()
  await waitFor(
    dm,
    (id) =>
      window.__atlasHost.runner.getSnapshot().state.table.combat.activeId !==
      id,
    aEntry.id,
    { timeout: 15000, label: "the turn moved on" }
  )
  checks.ok(true, "ending the turn hands it to the next combatant")

  // ---- pings --------------------------------------------------------------------------------------------
  checks.step("Pings: a player's long press, the DM's Shift + long press")
  const dmPings = []
  await dm.exposeFunction("__dmPing", (p) => dmPings.push(p))
  await dm.evaluate(() =>
    window.__atlasHost.runner.onPing((ev) => window.__dmPing(ev))
  )
  await A.page.bringToFront()
  const aBox = await A.page.locator("canvas").first().boundingBox()
  await longPress(A.page, aBox.width / 2 + 40, aBox.height / 2 + 30)
  await waitFor(B.page, () => window.__pings.length >= 1, null, {
    timeout: 10000,
    label: "B receives A's ping",
  })
  const bPing = (await B.page.evaluate(() => window.__pings))[0]
  checks.ok(
    bPing.name === "Aerin" && bPing.mine === false && !bPing.focus,
    "B sees Aerin's ping",
    bPing
  )
  checks.ok(
    dmPings.length === 1 && dmPings[0].from === A.uid,
    "the DM sees it too"
  )
  checks.ok(
    (await A.page.evaluate(() => window.__pings)).every((p) => p.mine),
    "A's own ping is drawn at once, not echoed"
  )
  await dm.bringToFront()
  const dmBox = await dm.locator("canvas").first().boundingBox()
  await longPress(dm, dmBox.width * 0.4, dmBox.height * 0.5, { shift: true })
  await waitFor(B.page, () => window.__pings.some((p) => p.focus), null, {
    timeout: 10000,
    label: "B receives the DM's look-here ping",
  })
  checks.ok(true, "the DM's Shift ping asks players to look")

  // ---- reload ------------------------------------------------------------------------------------------
  checks.step("B reloads: the log and the order come back")
  const before = await playerView(B.page)
  await drain()
  await B.page.reload({ waitUntil: "domcontentloaded" })
  await waitFor(
    B.page,
    () =>
      window.__atlasPlayer?.client.getSnapshot().status === "live" &&
      window.__atlasPlayer.client.getSnapshot().view?.table != null,
    null,
    { timeout: 45000, label: "B live again" }
  )
  const after = await playerView(B.page)
  checks.eq(texts(after), texts(before), "B's log is back")
  checks.eq(
    after.table.combat?.activeId ?? null,
    before.table.combat?.activeId ?? null,
    "B's order is back"
  )

  // ---- leaks -------------------------------------------------------------------------------------------
  checks.step("Nothing reached the wrong player")
  await drain()
  const hostNow = (await hostState(dm)).state
  const combatSecrets = {
    ids: [
      ...secrets.ids,
      // Entries the DM hid, and entries of hidden tokens.
      ...hostNow.table.combat.entries
        .filter((e) => e.hidden || hidden.some((t) => t.id === e.tokenId))
        .map((e) => e.id),
    ],
    strings: [...secrets.strings, "SENTINEL_SECRET_ROLL"],
  }
  const frames = (who, viewOnly = false) =>
    wire[who]
      .filter((f) => !viewOnly || f.name.includes(":view:"))
      .map((f, k) => ({ where: `${who} frame ${k}`, text: f.json }))
  // User ids: lobby presence legitimately names who is online, so only the view topic is scanned.
  const leaksA = [
    ...findLeaks(frames("A"), {
      ids: combatSecrets.ids,
      strings: [
        ...combatSecrets.strings,
        "SENTINEL_WHISPER_TO_DM",
        "SENTINEL_FOR_BRAM",
      ],
    }),
    ...findLeaks(frames("A", true), { ids: [B.uid], strings: [] }),
  ]
  const leaksB = [
    ...findLeaks(frames("B"), {
      ids: combatSecrets.ids,
      strings: combatSecrets.strings,
    }),
    ...findLeaks(frames("B", true), { ids: [A.uid], strings: [] }),
  ]
  checks.ok(
    findLeaks(frames("B"), { ids: [], strings: ["SENTINEL_FOR_BRAM"] }).length >
      0,
    "the scanner finds B's own whisper in B's frames (positive control)"
  )
  checks.eq(leaksA, [], "A never received B's whispers, secrets or B's id")
  checks.eq(leaksB, [], "B never received secrets or A's id")
  checks.ok(
    wire.A.length > 0 && wire.B.length > 0,
    "the scan saw the players' frames",
    { A: wire.A.length, B: wire.B.length }
  )
  // The stored player_views rows (what a player loads while the DM is away).
  const rows = await dm.evaluate(
    async ({ sid, uids }) => {
      const m = await import("/src/app/createServices.ts")
      const s = await m.createServices({ mode: "local" })
      const out = {}
      for (const uid of uids)
        out[uid] = JSON.stringify(await s.sessions.loadPlayerView(sid, uid))
      return out
    },
    { sid: h0.sessionId, uids: [A.uid, B.uid] }
  )
  checks.ok(
    rows[A.uid].includes("Hello from Aerin") &&
      rows[B.uid].includes("SENTINEL_FOR_BRAM"),
    "the stored views hold each player's log"
  )
  checks.eq(
    [
      ...findLeaks([{ where: "A's row", text: rows[A.uid] }], {
        ids: [...combatSecrets.ids, B.uid],
        strings: [
          ...combatSecrets.strings,
          "SENTINEL_WHISPER_TO_DM",
          "SENTINEL_FOR_BRAM",
        ],
      }),
      ...findLeaks([{ where: "B's row", text: rows[B.uid] }], {
        ids: [...combatSecrets.ids, A.uid],
        strings: combatSecrets.strings,
      }),
    ],
    [],
    "the stored views hold nothing for other eyes"
  )
  checks.eq(seriousErrors(logs), [], "no console errors")
} catch (err) {
  checks.fail("unexpected error", err)
} finally {
  await browser.close()
  if (logs.length) console.log(`\n${logs.slice(0, 40).join("\n")}`)
  checks.done()
}
