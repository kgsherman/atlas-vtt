// Areas of effect (spell templates) end to end in local mode (?local=1), through the real UI: the Area
// tool's picker and spell presets, placing on the map, the map chips and the details card.
//
// DM starts The Crooked Lantern → players A and B join and get a character each → the DM places a
// Fireball next to A's character: the host holds it, the DM's card lists A's character among the
// creatures caught (computed in 3D from the host's occlusion world), and every player's view equals the
// oracle (filterForPlayer) → A casts Burning Hands from their own token: it leaves the edge of A's space
// and is A's own in A's view → the DM tracks A's hit points and rolls the Fireball's damage from the
// card, whole then halved for a save: the log holds each roll and A's hit points drop by exactly that →
// the DM hides the Fireball: it leaves every view → the DM gives an NPC a Spirit Guardians aura, which
// follows it when it moves → A removes their template from its card → A reloads and the templates come
// back → no player ever received another player's id → the DM clears every area from the Table tab.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/templates-local.mjs
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
  mouseDrag,
  openSceneInEditor,
  playerView,
  projectIn,
  startSession,
  viewConverges,
} from "./session.mjs"

const OUT = outDir("templates-local")
const checks = new Checks("templates-local")
const logs = []
const browser = await openBrowser()

/** The host's templates. */
const templates = async (dm) => (await hostState(dm)).state.templates ?? []

async function waitTemplates(dm, pred, label, timeout = 20000) {
  const t0 = performance.now()
  let list = []
  while (performance.now() - t0 < timeout) {
    list = await templates(dm)
    if (pred(list)) return list
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(list)}`)
}

/** Pick a spell preset in the Area tool's picker (opening the tool first). */
async function pickPreset(page, name) {
  const picker = page.locator("[data-slot=template-picker]")
  if (!(await picker.isVisible()))
    await page.locator('[aria-label="Area of effect"]').first().click()
  await picker.waitFor({ timeout: 10000 })
  await picker.getByRole("button", { name: "Spell presets" }).click()
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click()
}

/** Ground point of a level at (x, z) in client px, in a page with an automation handle. */
async function groundPoint(page, handle, levelId, x, z) {
  const y = await page.evaluate(
    async ({ handle, levelId, x, z }) => {
      const { groundHeightAt } = await import("/src/core/scene/queries.ts")
      const h = window[handle]
      const scene =
        handle === "__atlasHost"
          ? h.runner.getSnapshot().state.scene
          : h.client.getSnapshot().scene
      return groundHeightAt(scene, levelId, { x, z })
    },
    { handle, levelId, x, z }
  )
  return projectIn(page, handle, { x, y, z })
}

/** What the host's own computation says an area catches (core/area on the full scene). */
async function hostCatches(dm, id) {
  return dm.evaluate(async (id) => {
    const [{ computeAreaEffect }, { templateArea }] = await Promise.all([
      import("/src/core/area/index.ts"),
      import("/src/core/session/templates.ts"),
    ])
    const runner = window.__atlasHost.runner
    const state = runner.getSnapshot().state
    const t = state.templates.find((x) => x.id === id)
    const g = templateArea(t, state.scene.tokens, state.scene.grid.cellSize)
    return computeAreaEffect(state.scene, runner.occlusion(), g, {
      noCells: true,
    }).tokenIds
  }, id)
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
  const pcs = Object.values(scene.tokens)
    .filter((t) => t.kind === "pc" && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
  const npc = Object.values(scene.tokens).find(
    (t) => t.kind === "npc" && !t.hidden
  )
  checks.ok(pcs.length >= 2 && npc, "the sample has two PCs and an NPC")
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
  await assignToken(dm, A, hero)
  await assignToken(dm, B, pcs[1])
  const wire = { A: [], B: [] }
  const drain = async () => {
    wire.A.push(...(await drainWire(A.page)))
    wire.B.push(...(await drainWire(B.page)))
  }

  // ---- the DM's Fireball ----------------------------------------------------------------------------------
  checks.step("The DM places a Fireball next to A's character")
  await dm.bringToFront()
  await pickPreset(dm, "Fireball")
  const at = await groundPoint(
    dm,
    "__atlasHost",
    hero.levelId,
    hero.position.x + 5,
    hero.position.z
  )
  await dm.mouse.move(at.x - 20, at.y, { steps: 3 })
  await dm.mouse.move(at.x, at.y, { steps: 3 })
  await sleep(600)
  await shot(dm, OUT, "01-dm-draft")
  await dm.mouse.down()
  await dm.mouse.up()
  const [fireball] = await waitTemplates(
    dm,
    (l) => l.length === 1,
    "the Fireball"
  )
  checks.ok(
    fireball.owner === null &&
      fireball.label === "Fireball" &&
      fireball.shape === "sphere" &&
      fireball.size === 20 &&
      fireball.levelId === hero.levelId &&
      fireball.x % 5 === 0 &&
      fireball.z % 5 === 0,
    "the host holds the DM's 20 ft sphere, centred on a grid intersection",
    fireball
  )
  const caught = await hostCatches(dm, fireball.id)
  checks.ok(caught.includes(hero.id), "it catches A's character", caught)
  const card = dm.locator("[data-slot=template-card]")
  await card.waitFor({ timeout: 15000 })
  checks.ok(
    (await card.textContent()).includes(hero.name),
    "the DM's card lists A's character among the creatures caught"
  )
  checks.eq(
    await dm
      .locator('[aria-label="Select and move"]')
      .first()
      .evaluate((el) => el.hasAttribute("data-pressed")),
    true,
    "placing it went back to the Move tool"
  )
  await shot(dm, OUT, "02-dm-card")
  checks.eq(
    await viewConverges(dm, A.page, A.uid, 15000),
    [],
    "A's view equals the oracle (with the template)"
  )
  checks.eq(
    await viewConverges(dm, B.page, B.uid, 15000),
    [],
    "B's view equals the oracle"
  )
  const va = await playerView(A.page)
  checks.ok(
    va.templates?.[fireball.id]?.dm === true &&
      va.templates[fireball.id].name === "DM" &&
      va.templates[fireball.id].mine === false,
    "A sees the DM's Fireball, placed by the DM",
    va.templates
  )
  await A.page.bringToFront()
  await A.page
    .locator(`[data-template-id="${fireball.id}"]`)
    .waitFor({ state: "attached", timeout: 15000 })
  await sleep(1000)
  await shot(A.page, OUT, "03-a-sees-fireball")

  // ---- A's Burning Hands ------------------------------------------------------------------------------------
  checks.step("A casts Burning Hands from their own token")
  await pickPreset(A.page, "Burning Hands")
  const heroNow = (await playerView(A.page)).tokens[hero.id]
  const from = await groundPoint(
    A.page,
    "__atlasPlayer",
    heroNow.levelId,
    heroNow.position.x,
    heroNow.position.z
  )
  const to = await groundPoint(
    A.page,
    "__atlasPlayer",
    heroNow.levelId,
    heroNow.position.x + 15,
    heroNow.position.z
  )
  await mouseDrag(A.page, from, to, 10)
  const list = await waitTemplates(
    dm,
    (l) => l.some((t) => t.owner === A.uid),
    "A's template"
  )
  const hands = list.find((t) => t.owner === A.uid)
  checks.ok(
    hands.shape === "cone" &&
      hands.size === 15 &&
      Math.abs(hands.x - (heroNow.position.x + 2.5)) < 0.01 &&
      Math.abs(hands.z - heroNow.position.z) < 0.01 &&
      Math.abs(hands.angle) < 0.2,
    "the cone leaves the edge of A's space, aimed where A dragged",
    hands
  )
  await waitFor(
    A.page,
    (id) =>
      window.__atlasPlayer.client.getSnapshot().view?.templates?.[id]?.mine ===
      true,
    hands.id,
    { timeout: 15000, label: "A's view has its own template" }
  )
  checks.ok(true, "A's view marks the cone as A's own")
  await sleep(1000)
  await shot(A.page, OUT, "04-a-burning-hands")
  checks.eq(
    await viewConverges(dm, B.page, B.uid, 15000),
    [],
    "B's view equals the oracle"
  )
  const vb = await playerView(B.page)
  if (vb.templates?.[hands.id])
    checks.ok(
      vb.templates[hands.id].name === "Aerin" &&
        !vb.templates[hands.id].mine,
      "B sees A's cone by A's name"
    )

  // ---- damage from the card ---------------------------------------------------------------------------------
  checks.step("The DM rolls the Fireball's damage from its card")
  await dm.bringToFront()
  await dm.evaluate(
    (tokenId) =>
      window.__atlasHost.runner.dispatch({
        t: "set-token-status",
        tokenId,
        hp: { max: 200, current: 200, temp: 0 },
      }),
    hero.id
  )
  // Its card is still open from placing it (a chip click would close it).
  await card.getByText("Fireball").first().waitFor({ timeout: 10000 })
  const hpOf = async () =>
    (await hostState(dm)).state.scene.tokens[hero.id].hp.current
  const rollsOf = async () =>
    (await hostState(dm)).state.table.log.filter(
      (m) => m.kind === "roll" && m.text === "Fireball"
    )
  await card.getByLabel("Damage dice").fill("8d6")
  await card.getByRole("button", { name: "Roll damage" }).click()
  await waitFor(
    dm,
    () =>
      (window.__atlasHost.runner.getSnapshot().state.table?.log ?? []).some(
        (m) => m.kind === "roll" && m.text === "Fireball"
      ),
    null,
    { label: "the damage roll" }
  )
  let rolls = await rollsOf()
  const full = rolls[0].roll.total
  checks.eq(await hpOf(), 200 - full, "A's character took the whole roll")
  checks.ok(
    rolls[0].to === "all" && rolls[0].roll.formula.startsWith("8d6"),
    "the roll is public, 8d6"
  )
  await card
    .getByRole("checkbox", { name: `${hero.name} saved (half damage)` })
    .click()
  await card.getByRole("button", { name: "Roll damage" }).click()
  await waitFor(
    dm,
    () =>
      (window.__atlasHost.runner.getSnapshot().state.table?.log ?? []).filter(
        (m) => m.kind === "roll" && m.text === "Fireball"
      ).length === 2,
    null,
    { label: "the second damage roll" }
  )
  rolls = await rollsOf()
  const second = rolls[1].roll.total
  checks.eq(
    await hpOf(),
    200 - full - Math.floor(second / 2),
    "a save halves it (rounded down)"
  )
  await shot(dm, OUT, "05-dm-damage")

  // ---- hiding ------------------------------------------------------------------------------------------------
  checks.step("The DM hides the Fireball from players")
  await card.getByRole("button", { name: "Hide from players" }).click()
  await waitTemplates(
    dm,
    (l) => l.find((t) => t.id === fireball.id)?.hidden === true,
    "hidden Fireball"
  )
  await waitFor(
    A.page,
    (id) => !window.__atlasPlayer.client.getSnapshot().view?.templates?.[id],
    fireball.id,
    { timeout: 15000, label: "A no longer has the Fireball" }
  )
  checks.ok(true, "the hidden Fireball left A's view")
  checks.eq(
    await viewConverges(dm, B.page, B.uid, 15000),
    [],
    "B's view equals the oracle (no hidden template)"
  )
  checks.ok(
    (await card.textContent()).includes("Show players"),
    "the DM's card offers to show it again"
  )

  // ---- an aura ----------------------------------------------------------------------------------------------
  checks.step("An aura follows the token carrying it")
  await pickPreset(dm, "Spirit Guardians")
  const npcAt = await groundPoint(
    dm,
    "__atlasHost",
    npc.levelId,
    npc.position.x,
    npc.position.z
  )
  await dm.mouse.move(npcAt.x, npcAt.y, { steps: 3 })
  await sleep(300)
  await dm.mouse.down()
  await dm.mouse.up()
  const withAura = await waitTemplates(
    dm,
    (l) => l.some((t) => t.tokenId === npc.id),
    "the aura"
  )
  const aura = withAura.find((t) => t.tokenId === npc.id)
  checks.ok(
    aura.shape === "sphere" && aura.size === 15 && aura.label === "Spirit Guardians",
    "the aura is carried by the NPC",
    aura
  )
  const moved = { x: npc.position.x + 5, z: npc.position.z }
  await dm.evaluate(
    ({ id, levelId, p }) =>
      window.__atlasHost.runner.dispatch({
        t: "move-token",
        tokenId: id,
        levelId,
        x: p.x,
        z: p.z,
      }),
    { id: npc.id, levelId: npc.levelId, p: moved }
  )
  checks.eq(
    await viewConverges(dm, A.page, A.uid, 15000),
    [],
    "A's view equals the oracle after the carrier moved"
  )
  const va2 = await playerView(A.page)
  if (va2.tokens[npc.id])
    checks.ok(
      va2.templates?.[aura.id]?.x === moved.x &&
        va2.templates[aura.id].tokenId === npc.id,
      "A, who sees the NPC, gets the aura where the NPC now is"
    )
  else
    checks.ok(
      !va2.templates?.[aura.id],
      "A, who cannot see the NPC, gets no aura"
    )
  await sleep(800)
  await shot(dm, OUT, "06-dm-aura")

  // ---- removing, reloading ---------------------------------------------------------------------------------
  checks.step("A removes their cone from its card; a reload brings the rest back")
  await A.page.bringToFront()
  await A.page.locator(`[data-template-id="${hands.id}"] button`).click()
  const aCard = A.page.locator("[data-slot=template-card]")
  await aCard.waitFor({ timeout: 10000 })
  checks.ok(
    (await aCard.textContent()).includes("placed by you"),
    "A's card says A placed it"
  )
  await aCard.getByRole("button", { name: "Remove" }).click()
  await waitTemplates(
    dm,
    (l) => !l.some((t) => t.id === hands.id),
    "A's cone removed"
  )
  checks.ok(true, "the host removed A's cone")
  await drain()
  const before = await playerView(A.page)
  await A.page.reload({ waitUntil: "domcontentloaded" })
  await waitFor(
    A.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "live",
    null,
    { timeout: 45000, label: "A live again" }
  )
  checks.eq(
    await viewConverges(dm, A.page, A.uid, 15000),
    [],
    "A's view equals the oracle after the reload"
  )
  checks.eq(
    Object.keys((await playerView(A.page)).templates ?? {}).sort(),
    Object.keys(before.templates ?? {}).sort(),
    "A's templates came back"
  )

  // ---- leaks -------------------------------------------------------------------------------------------------
  checks.step("No player received another player's id")
  await drain()
  const frames = (who) =>
    wire[who]
      .filter((f) => f.name.includes(":view:"))
      .map((f, k) => ({ where: `${who} frame ${k}`, text: f.json }))
  checks.ok(
    frames("A").some((f) => f.text.includes("Burning Hands")),
    "the scan saw A's templates on the wire (positive control)"
  )
  checks.eq(
    findLeaks(frames("A"), { ids: [B.uid], strings: [] }),
    [],
    "A's frames never hold B's id"
  )
  checks.eq(
    findLeaks(frames("B"), { ids: [A.uid], strings: [] }),
    [],
    "B's frames never hold A's id (A's templates travel by name)"
  )

  // ---- clearing -----------------------------------------------------------------------------------------
  checks.step("The DM clears every area from the Table tab")
  await dm.bringToFront()
  await dm.getByRole("tab", { name: /Table/ }).click()
  await dm.getByRole("button", { name: "Clear all areas" }).click()
  await waitTemplates(dm, (l) => l.length === 0, "no templates")
  await waitFor(
    A.page,
    () => !window.__atlasPlayer.client.getSnapshot().view?.templates,
    null,
    { timeout: 15000, label: "A has no templates" }
  )
  checks.ok(true, "the host and A's view hold no template any more")
  checks.eq(seriousErrors(logs), [], "no console errors")
} catch (err) {
  checks.fail("unexpected error", err)
} finally {
  await browser.close()
  if (logs.length) console.log(`\n${logs.slice(0, 40).join("\n")}`)
  checks.done()
}
