// The scene screen and its table, end to end (local mode, a copy of The Crooked Lantern in a new world;
// ARCHITECTURE §6.8):
//
//   1. Opening a scene: Edit, its table closed. Tab switches Edit ↔ Play; undo survives the round trip.
//   2. Restore points: a crate added in Edit, Ctrl+S → a new saved version of the scene holding it.
//   3. The table's doors: open → a player joins; close → the player's page says so and the DM keeps
//      editing (a second crate); open again → the player is back without doing anything.
//   4. Leaving with the table open asks; "Leave it open" → the world's page, the player waits. The scene
//      card's Play opens the same table, in Play, with both crates.
//   5. Version history: restoring version 1 takes the crates away for the table; undo brings them back.
//   6. "Close the table and leave" keeps a restore point: the saved scene is as it was left.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/map-table-local.mjs
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
import { joinGame, openSceneInEditor, startSession } from "./session.mjs"

const OUT = outDir("map-table-local")
const checks = new Checks("map-table-local")
const logs = []
const browser = await openBrowser()
let dm = null

/** Add a crate (a copy of one of the scene's own) at a cell of the active level, in Edit. */
async function addCrate(dm, name, [dx, dz] = [0, 0]) {
  await waitFor(
    dm,
    () => window.__atlasHost?.mode === "edit" && window.__atlasEditor != null,
    null,
    {
      label: "Edit",
    }
  )
  const id = `e2e${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
  return evaluateRetry(
    dm,
    ({ id, name, dx, dz }) => {
      const store = window.__atlasEditor.store
      const s = store.getState()
      if (Object.hasOwn(s.scene.objects, id)) return id
      const g = s.scene.grid
      const model = Object.values(s.scene.objects).find(
        (o) => o.type === "prop" && o.kind === "crate"
      )
      if (!model) throw new Error("the scene has no crate to copy")
      const crate = {
        ...structuredClone(model),
        id,
        name,
        levelId: s.activeLevelId,
        position: {
          x: (Math.floor(g.width / 2) + dx + 0.5) * g.cellSize,
          y: 0,
          z: (Math.floor(g.depth / 2) + dz + 0.5) * g.cellSize,
        },
      }
      store.getState().apply((d) => {
        d.objects[id] = crate
      }, "Add crate")
      return Object.hasOwn(store.getState().scene.objects, id) ? id : null
    },
    { id, name, dx, dz }
  )
}

/**
 * page.evaluate with retries. The first evaluate on the DM tab right after another tab of the context
 * closed sometimes fails with "Resulting promise was garbage collected" (a Playwright / Chromium quirk,
 * not an app error); the retried call then succeeds.
 */
async function evaluateRetry(page, fn, arg, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      return await page.evaluate(fn, arg)
    } catch (err) {
      if (
        k >= tries ||
        !/garbage collected|context was destroyed/i.test(String(err?.message))
      )
        throw err
      console.log(
        `   (evaluate retried: ${String(err.message).split("\n")[0]})`
      )
      await sleep(300)
    }
  }
}

/** The saved scene's latest version (local mode repositories, as the DM). */
async function savedScene(page, sceneId) {
  return page.evaluate(async (sceneId) => {
    const m = await import("/src/app/createServices.ts")
    const s = await m.createServices({ mode: "local" })
    const doc = await s.scenes.load(sceneId)
    const scene = doc?.parsed?.ok ? doc.parsed.scene : null
    return {
      version: doc?.version ?? doc?.summary?.latestVersion ?? null,
      name: scene?.name ?? null,
      objectIds: scene ? Object.keys(scene.objects) : [],
    }
  }, sceneId)
}

/** The live scene's object ids (the host's GameState). */
const liveObjects = (page) =>
  page.evaluate(() =>
    Object.keys(window.__atlasHost.runner.getSnapshot().state.scene.objects)
  )

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  dm = await context.newPage()
  watchPage(dm, "dm", logs)

  checks.step("Open a scene: Edit, the table closed; Tab switches")
  const sceneId = await openSceneInEditor(dm, { mode: "local" })
  const { sessionId, worldId } = await dm.evaluate(() => {
    const snap = window.__atlasHost.runner.getSnapshot()
    return { sessionId: snap.sessionId, worldId: snap.world?.id ?? null }
  })
  checks.ok(worldId !== null, "the table knows its world")
  checks.eq(
    await dm.evaluate(() => window.__atlasHost.runner.getSnapshot().tableOpen),
    false,
    "the table starts closed"
  )
  const first = await addCrate(dm, "E2E crate")
  checks.ok(first !== null, "a crate is added in Edit")
  await dm.mouse.move(700, 450)
  await dm.keyboard.press("Tab")
  await waitFor(dm, () => window.__atlasHost.mode === "play", null, {
    label: "Play",
  })
  await dm.keyboard.press("Tab")
  await waitFor(dm, () => window.__atlasHost.mode === "edit", null, {
    label: "Edit",
  })
  checks.ok(true, "Tab → Play → Edit")
  await dm.keyboard.press("Control+z")
  await sleep(200)
  checks.ok(
    !(await liveObjects(dm)).includes(first),
    "undo after the round trip removes the crate from the live scene"
  )
  await dm.keyboard.press("Control+Shift+z")
  await sleep(200)
  checks.ok((await liveObjects(dm)).includes(first), "redo puts it back")

  checks.step("A restore point")
  await dm.keyboard.press("Control+s")
  await waitFor(
    dm,
    () => {
      const lib = window.__atlasHost.runner.getSnapshot().library
      return lib?.version === 2 && !lib.dirty
    },
    null,
    { label: "restore point" }
  )
  const v2 = await savedScene(dm, sceneId)
  checks.ok(
    v2.version === 2 && v2.objectIds.includes(first),
    "the saved version 2 holds the crate",
    v2
  )

  checks.step("Open the table, close it, open it again")
  const h = await startSession(dm)
  const player = await joinGame(context, {
    roomCode: h.roomCode,
    name: "Ana",
    logs,
  })
  checks.ok(true, "a player joins")
  await dm.bringToFront()
  await dm.getByRole("button", { name: /Table open/ }).click()
  await dm.getByRole("menuitem", { name: /Close the table/ }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Close the table" })
    .click()
  await waitFor(
    player.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "closed",
    null,
    {
      timeout: 15000,
      label: "the player's table closes",
    }
  )
  checks.ok(
    await player.page.getByText("The table is closed").isVisible(),
    "the player's page says the table is closed"
  )
  await dm.bringToFront()
  await dm.getByRole("alertdialog").waitFor({ state: "detached" })
  await dm.keyboard.press("Tab")
  const second = await addCrate(dm, "E2E crate 2", [1, 0])
  checks.ok(second !== null, "the DM keeps editing while the table is closed")
  await dm.getByRole("button", { name: "Open the table" }).click()
  await waitFor(
    player.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "live",
    null,
    {
      timeout: 30000,
      label: "the player is back",
    }
  )
  checks.ok(true, "the player is back once the table opens")
  await shot(player.page, OUT, "01-player-back")

  checks.step("Leave with the table open, come back through Play")
  await dm.bringToFront()
  await dm.getByRole("button", { name: "Back to the world" }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Leave it open" })
    .click()
  await waitFor(dm, (id) => location.pathname === `/world/${id}`, worldId, {
    label: "the world page",
  })
  await waitFor(
    player.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "host-offline",
    null,
    {
      timeout: 20000,
      label: "the player waits for the DM",
    }
  )
  checks.ok(true, "the player waits for the DM")
  await dm
    .locator("[data-slot=card]", { hasText: "The Crooked Lantern" })
    .first()
    .getByRole("button", { name: "Play", exact: true })
    .click()
  await waitFor(
    dm,
    () =>
      window.__atlasHost?.runner.getSnapshot().status === "hosting" &&
      window.__atlasHost.mode === "play",
    null,
    {
      timeout: 60000,
      label: "back at the table, in Play",
    }
  )
  checks.eq(
    await dm.evaluate(() => window.__atlasHost.runner.getSnapshot().sessionId),
    sessionId,
    "the same table"
  )
  const back = await liveObjects(dm)
  checks.ok(
    back.includes(first) && back.includes(second),
    "both crates are in the scene"
  )
  await waitFor(
    player.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "live",
    null,
    {
      timeout: 30000,
      label: "the player is live again",
    }
  )
  checks.ok(true, "the player is live again")

  checks.step("Version history: restore version 1, undo")
  await dm
    .getByRole("menuitem", { name: "File" })
    .or(dm.getByRole("button", { name: "File" }))
    .first()
    .click()
  await dm.getByRole("menuitem", { name: /Version history/ }).click()
  const sheet = dm.locator("[data-slot=sheet-content]")
  await sheet
    .getByText("Version 1", { exact: true })
    .waitFor({ timeout: 10000 })
  await shot(dm, OUT, "02-versions")
  await sheet
    .locator("div", { has: dm.getByText("Version 1", { exact: true }) })
    .getByRole("button", { name: "Restore" })
    .last()
    .click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Restore" })
    .click()
  await waitFor(
    dm,
    (ids) =>
      !ids.some((id) =>
        Object.hasOwn(
          window.__atlasHost.runner.getSnapshot().state.scene.objects,
          id
        )
      ),
    [first, second],
    {
      timeout: 15000,
      label: "version 1 restored",
    }
  )
  checks.ok(true, "restoring version 1 takes the crates away")
  // Shortcuts wait until the sheet and the confirmation have gone.
  await waitFor(
    dm,
    () =>
      !document.querySelector(
        "[data-slot=sheet-content], [data-slot=alert-dialog-content]"
      ),
    null,
    {
      label: "dialogs closed",
    }
  )
  await dm.mouse.move(700, 450)
  await dm.keyboard.press("Tab")
  await waitFor(dm, () => window.__atlasHost.mode === "edit", null, {
    label: "Edit",
  })
  await dm.keyboard.press("Control+z")
  await sleep(300)
  const undone = await liveObjects(dm)
  checks.ok(
    undone.includes(first) && undone.includes(second),
    "undo brings them back"
  )

  checks.step("Close the table and leave: a restore point")
  await dm.getByRole("button", { name: "Back to the world" }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Close the table and leave" })
    .click()
  await waitFor(dm, (id) => location.pathname === `/world/${id}`, worldId, {
    timeout: 20000,
    label: "the world page",
  })
  const last = await savedScene(dm, sceneId)
  checks.ok(
    last.version > 2 &&
      last.objectIds.includes(first) &&
      last.objectIds.includes(second),
    "the saved scene is as it was left",
    last
  )
  await waitFor(
    player.page,
    () => window.__atlasPlayer?.client.getSnapshot().status === "closed",
    null,
    {
      timeout: 20000,
      label: "the player's table closes",
    }
  )
  checks.ok(true, "the player's table is closed")
} catch (err) {
  checks.fail("map-table-local crashed", err)
  if (dm) await shot(dm, OUT, "zz-failure").catch(() => {})
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
