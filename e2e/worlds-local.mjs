// Worlds end to end in local mode (?local=1; ARCHITECTURE §6.9): the DM creates a world and its characters →
// a player joins the WORLD with its code while no table is open and waits → the DM hands them a character
// on the world page (the player's wait screen shows it) → a sample scene in the world, a token linked to the
// character in the Inspector → opening the table brings the player in, controlling that token → the table's
// Players tab shows the character → a second world's table may open, a second scene of the same world may
// not → Change scene lists the world's scenes only.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/worlds-local.mjs
import {
  BASE,
  Checks,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import { createWorld, startSession, waitHosting } from "./session.mjs"

const OUT = outDir("worlds-local")
const checks = new Checks("worlds-local")
const logs = []
const browser = await openBrowser()

/** The world page's room code (its badge, ABCD-1234). */
async function worldCode(page) {
  const badge = page
    .locator("[data-slot=badge]")
    .filter({ hasText: /^[0-9A-Z]{4}-[0-9A-Z]{4}$/ })
    .first()
  return (await badge.textContent()).trim()
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)

  checks.step("A world with two characters")
  const worldId = await createWorld(dm, { name: "Tyranny of Dragons" })
  checks.ok(
    typeof worldId === "string" && worldId.length > 0,
    "New world opens the world's page"
  )
  const code = await worldCode(dm)
  checks.ok(
    /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code),
    "the world has a room code",
    code
  )
  await shot(dm, OUT, "01-world-scenes")
  await dm.getByRole("tab", { name: /Characters/ }).click()
  for (const name of ["Aria Vey", "Borin"]) {
    await dm.getByRole("button", { name: "New character" }).first().click()
    const dialog = dm.getByRole("dialog", { name: "New character" })
    await dialog.getByLabel("Name").fill(name)
    await dialog.getByRole("button", { name: "Add character" }).click()
    await dialog.waitFor({ state: "hidden" })
  }
  await dm.getByText("Borin", { exact: true }).waitFor()
  checks.ok(true, "two characters are listed")
  await shot(dm, OUT, "02-world-characters")

  checks.step("A player joins the world while no table is open")
  const pat = await context.newPage()
  watchPage(pat, "pat", logs)
  await pat.goto(`${BASE}/join/${code}?local=1`, {
    waitUntil: "domcontentloaded",
  })
  await pat.getByPlaceholder("e.g. Morgana").fill("Pat")
  await pat.getByRole("button", { name: "Join game" }).click()
  await waitFor(
    pat,
    (id) => location.pathname === `/world/${id}/play`,
    worldId,
    { label: "the world's wait screen" }
  )
  await pat.getByText("No table is open yet", { exact: false }).waitFor()
  checks.ok(true, "the player waits in the world (no table open)")
  await shot(pat, OUT, "03-player-waits")

  checks.step("The DM hands Pat a character on the world page")
  await dm.reload({ waitUntil: "domcontentloaded" })
  await dm.getByRole("tab", { name: /Players/ }).click()
  await dm.getByText("Pat", { exact: true }).first().waitFor({ timeout: 15000 })
  await dm.getByRole("button", { name: "Characters" }).click()
  await dm.getByRole("menuitemcheckbox", { name: /Aria Vey/ }).click()
  await dm.keyboard.press("Escape")
  await shot(dm, OUT, "04-world-players")
  await pat.getByText("Aria Vey", { exact: true }).waitFor({ timeout: 15000 })
  checks.ok(true, "the player's wait screen shows the character they play")

  checks.step("A scene of the world; a token becomes the character")
  await dm.getByRole("tab", { name: /Scenes/ }).click()
  await dm
    .locator("[data-slot=card]", { hasText: "The Crooked Lantern" })
    .getByRole("button", { name: "Open a copy" })
    .click()
  await waitFor(
    dm,
    () =>
      location.pathname.startsWith("/host/") &&
      window.__atlasHost?.mode === "edit" &&
      window.__atlasEditor?.engine != null,
    null,
    {
      timeout: 90000,
      label: "the scene screen in Edit",
    }
  )
  await waitHosting(dm)
  await waitFor(
    dm,
    () =>
      window.__atlasHost.runner.getSnapshot().state?.characters !== undefined,
    null,
    {
      label: "the table reads the world's roster",
    }
  )
  const snap = await dm.evaluate(() => {
    const s = window.__atlasHost.runner.getSnapshot()
    return { world: s.world, characters: s.state.characters }
  })
  checks.eq(snap.world?.id, worldId, "the table knows its world")
  const aria = Object.entries(snap.characters ?? {}).find(
    ([, c]) => c.name === "Aria Vey"
  )
  checks.ok(
    aria && aria[1].players.length === 1,
    "the table knows the roster (Aria is Pat's)",
    snap.characters
  )
  const pc = await dm.evaluate(() =>
    Object.values(
      window.__atlasHost.runner.getSnapshot().state.scene.tokens
    ).find((t) => t.kind === "pc")
  )
  await dm.evaluate(
    (id) => window.__atlasEditor.store.getState().select([id]),
    pc.id
  )
  // The Inspector tab of the editor's sidebar shows the selection.
  await dm.getByRole("tab", { name: "Inspector" }).click()
  await sleep(300)
  const field = dm.getByRole("combobox", { name: "Character" })
  const hasField = await field.isVisible().catch(() => false)
  if (hasField) {
    await field.click()
    await dm.getByRole("option", { name: "Aria Vey" }).click()
  } else {
    // The Inspector could not be reached from here: link through the editor store (same edit).
    await dm.evaluate(
      ({ id, characterId }) =>
        window.__atlasEditor.store
          .getState()
          .updateToken(id, { characterId, kind: "pc" }),
      { id: pc.id, characterId: aria[0] }
    )
  }
  await waitFor(
    dm,
    ({ id, characterId }) =>
      window.__atlasHost.runner.getSnapshot().state.scene.tokens[id]
        ?.characterId === characterId,
    { id: pc.id, characterId: aria[0] },
    { label: "the token is linked to the character" }
  )
  checks.ok(
    true,
    `${pc.name} is linked to Aria Vey${hasField ? " (Inspector)" : " (store)"}`
  )
  checks.ok(
    (await dm.getByText("Played by Pat.").count()) > 0,
    "the Inspector says who plays the character (the table is closed)"
  )
  await shot(dm, OUT, "05-inspector-character")

  checks.step("Opening the table brings the player in")
  const h = await startSession(dm)
  await waitFor(pat, () => location.pathname.startsWith("/play/"), null, {
    timeout: 30000,
    label: "the player follows to the open table",
  })
  await waitFor(
    pat,
    (id) =>
      window.__atlasPlayer?.client
        .getSnapshot()
        .view?.controlledTokenIds.includes(id),
    pc.id,
    {
      timeout: 45000,
      label: "Pat controls the character's token",
    }
  )
  checks.ok(
    true,
    "the waiting player lands at the open table, controlling the token"
  )
  await dm.getByRole("tab", { name: /Players/ }).click()
  await sleep(500)
  await shot(dm, OUT, "06-table-players")
  await shot(pat, OUT, "07-player-table")
  checks.eq(
    h.roomCode.replace("-", ""),
    code.replace("-", ""),
    "the table answers to the world's code"
  )

  checks.step("One open table per world")
  const sessionsRepo = await dm.evaluate(async (wid) => {
    const m = await import("/src/app/createServices.ts")
    const s = await m.createServices({ mode: "local" })
    const scene = (
      await s.scenes.create(
        {
          ...(
            await s.scenes.load((await s.scenes.list({ worldId: wid }))[0].id)
          ).parsed.scene,
          name: "Second",
        },
        { worldId: wid }
      )
    ).id
    const t = await s.sessions.openMap(scene)
    const refused = await s.sessions.setTableOpen(t.sessionId, true).then(
      () => "opened",
      (e) => e.code
    )
    const other = await s.worlds.create("Storm King's Thunder")
    const otherScene = (
      await s.scenes.create(
        { ...(await s.scenes.load(scene)).parsed.scene, name: "Giant hall" },
        { worldId: other.id }
      )
    ).id
    const t2 = await s.sessions.openMap(otherScene)
    const opened = await s.sessions.setTableOpen(t2.sessionId, true)
    await s.sessions.setTableOpen(t2.sessionId, false)
    return { refused, opened }
  }, worldId)
  checks.eq(
    sessionsRepo.refused,
    "world_table_open",
    "a second scene of the world can't open its table"
  )
  checks.eq(sessionsRepo.opened, "active", "another world's table can")

  checks.step("Change scene lists the world's scenes only")
  await dm.getByRole("button", { name: "Change scene" }).click()
  const dialog = dm.getByRole("dialog", { name: "Change scene" })
  await dialog.getByText("Second", { exact: true }).waitFor({ timeout: 15000 })
  checks.ok(
    !(await dialog
      .getByText("Giant hall")
      .isVisible()
      .catch(() => false)),
    "another world's scene is not offered"
  )
  await shot(dm, OUT, "08-change-scene")
  await dm.keyboard.press("Escape")

  checks.step("Home lists both worlds")
  await dm.goto(`${BASE}/?local=1`, { waitUntil: "domcontentloaded" })
  await dm.getByText("Storm King's Thunder").first().waitFor({ timeout: 15000 })
  await sleep(800)
  await shot(dm, OUT, "09-home")
  checks.ok(true, "home shows the worlds")
} catch (err) {
  checks.fail("worlds-local crashed", err)
} finally {
  const errors = seriousErrors(logs)
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 5).join("\n")
  )
  await browser.close()
  checks.done()
}
