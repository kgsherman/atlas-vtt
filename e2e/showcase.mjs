// Showcase screenshots (1920×1080) of the scene screen in Edit and in Play and players' fog-of-war views, per
// quality tier, in local mode:
//   - The Crooked Lantern sample (our own art)  → docs/screenshots/
//   - The Vineyard (test_maps/vineyard.atlas.json, built by e2e/vineyard-build.mjs; third-party art)
//                                                → test_maps/screenshots/ (gitignored)
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/showcase.mjs
//   ATLAS_QUALITIES=ultra,medium  ATLAS_SCENES=crooked,vineyard   (defaults)
import fs from "node:fs"
import path from "node:path"

import {
  Checks,
  openBrowser,
  REPO,
  seriousErrors,
  sleep,
  TEST_MAPS,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  hostState,
  joinGame,
  openSceneInEditor,
  startSession,
} from "./session.mjs"

const QUALITIES = (process.env.ATLAS_QUALITIES ?? "ultra,medium").split(",")
const SCENES = (process.env.ATLAS_SCENES ?? "crooked,vineyard").split(",")
const VINEYARD_FILE = path.join(TEST_MAPS, "vineyard.atlas.json")
const VIEWPORT = { width: 1920, height: 1080 }

const checks = new Checks("showcase")
const logs = []
const browser = await openBrowser()

/** Freeze the engine of a page (editor / host / player handle) at a quality tier and let it settle. */
async function setQuality(page, handle, quality, settleMs = 2500) {
  await page.evaluate(
    ({ handle, quality }) => {
      const engine = window[handle].engine
      engine.debugFreezeQuality?.(true)
      engine.setQuality(quality)
    },
    { handle, quality }
  )
  await sleep(settleMs)
}

/** ATLAS_SHOWCASE_DIR redirects every shot (e.g. to review them before replacing the published ones). */
async function save(page, dir, name) {
  dir = process.env.ATLAS_SHOWCASE_DIR ?? dir
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  ✓ ${path.relative(REPO, file)}`)
}

const SHOWCASES = {
  crooked: {
    open: { sample: "The Crooked Lantern" },
    dir: path.join(REPO, "docs", "screenshots"),
    prefix: "crooked-lantern",
    // The roof is hidden so the orbit looks into the upper storey's rooms.
    orbit: {
      azimuth: -0.65,
      elevation: 0.7,
      level: "Upper Floor",
      hide: ["Roof"],
      focus: { x: 95, y: 0, z: 62 },
      distance: 185,
    },
    dmLevel: "Ground Floor",
    players: [
      {
        name: "Morgana",
        token: /^Pip/,
        shot: "player-halfling-courtyard-night",
      },
      { name: "Theron", token: /^Brunhild/, shot: "player-dwarf-common-room" },
      { name: "Isolde", token: /^Ser Aldric/, shot: "player-fighter-balcony" },
    ],
  },
  vineyard: {
    open: { file: VINEYARD_FILE },
    dir: path.join(TEST_MAPS, "screenshots"),
    prefix: "vineyard",
    orbit: {
      azimuth: -0.55,
      elevation: 0.78,
      level: "Second Floor",
      hide: [],
      focus: { x: 66, y: 0, z: 78 },
      distance: 175,
    },
    dmLevel: "Ground Floor",
    players: [
      {
        name: "Morgana",
        token: /^Wren/,
        shot: "player-halfling-courtyard-night",
      },
      // The DM walks the dwarf down to the dark east shelf of the sea cave (darkvision, greyscale).
      {
        name: "Theron",
        token: /^Brunhild/,
        shot: "player-dwarf-darkvision-basement",
        move: { level: "Basement", x: 92.5, z: 77.5 },
      },
      // …and the fighter up to the manor's upper storey.
      {
        name: "Isolde",
        token: /^Aldric/,
        shot: "player-fighter-upstairs",
        move: { level: "Second Floor", x: 37.5, z: 22.5 },
      },
    ],
  },
}

async function runScene(key, quality) {
  const sc = SHOWCASES[key]
  const tag = (name) => `${sc.prefix}-${name}-${quality}`
  checks.step(`${key} @ ${quality}`)
  const context = await browser.newContext({
    viewport: VIEWPORT,
    acceptDownloads: false,
  })
  try {
    const dm = await context.newPage()
    watchPage(dm, `dm-${key}`, logs)
    await openSceneInEditor(dm, { mode: "local", ...sc.open })

    // Editor: 3D orbit over every level (no ghosts, helpers or grid).
    await dm.evaluate(({ level: levelName, hide }) => {
      const s = window.__atlasEditor.store.getState()
      const levels = Object.values(s.scene.levels)
      const level = levels.find((l) => l.name === levelName)
      if (level) s.setActiveLevel(level.id)
      const levelVisibility = Object.fromEntries(
        levels.filter((l) => hide.includes(l.name)).map((l) => [l.id, false])
      )
      s.setView({
        camera: "orbit",
        ghostAdjacent: false,
        showHelpers: false,
        showGrid: false,
        levelVisibility,
      })
    }, sc.orbit)
    await setQuality(dm, "__atlasEditor", quality, 500)
    await dm.evaluate(({ azimuth, elevation, focus, distance }) => {
      const e = window.__atlasEditor.engine
      e.focus(focus, { distance, immediate: true })
      e.setOrbitAngles?.(azimuth, elevation)
    }, sc.orbit)
    await sleep(2500)
    await save(dm, sc.dir, tag("editor-orbit"))
    await dm.evaluate(() =>
      window.__atlasEditor.store.getState().setView({
        ghostAdjacent: true,
        showHelpers: true,
        showGrid: true,
        levelVisibility: {},
      })
    )

    // The scene screen in Play, top-down over the ground floor (Edit and Play share the camera and the
    // level, left in orbit over the upper floor above), without the "table is open" toast.
    const session = await startSession(dm)
    await dm.getByRole("button", { name: "Top-down (2.5D) camera" }).click()
    await dm.getByRole("button", { name: sc.dmLevel, exact: true }).click()
    for (const close of await dm
      .locator("[data-sonner-toast] [data-close-button]")
      .all())
      await close.click().catch(() => {})
    await setQuality(dm, "__atlasHost", quality, 500)
    await dm.evaluate(() => window.__atlasHost.engine.frameScene())
    await sleep(2500)
    await save(dm, sc.dir, tag("dm-topdown"))

    // Players: one tab each, closed after its shot so only two renderers share the GPU.
    const scene = (await hostState(dm)).state.scene
    for (const p of sc.players) {
      const token = Object.values(scene.tokens).find((t) =>
        p.token.test(t.name)
      )
      if (!token) throw new Error(`no token ${p.token} in ${key}`)
      if (p.move) {
        const level = Object.values(scene.levels).find(
          (l) => l.name === p.move.level
        )
        await dm.evaluate(
          ({ tokenId, levelId, x, z }) =>
            window.__atlasHost.runner.dispatch({
              t: "move-token",
              tokenId,
              levelId,
              x,
              z,
            }),
          { tokenId: token.id, levelId: level.id, x: p.move.x, z: p.move.z }
        )
      }
      const player = await joinGame(context, {
        roomCode: session.roomCode,
        name: p.name,
        logs,
      })
      await assignToken(dm, player, token)
      await player.page.bringToFront()
      await player.page.evaluate(
        (id) => window.__atlasPlayer.select(id),
        token.id
      )
      await setQuality(player.page, "__atlasPlayer", quality, 500)
      // Backdrop tiles (local mode crops them from the stored map) and shadow tiles settle.
      await waitFor(
        player.page,
        () =>
          window.__atlasPlayer.client
            .backdropLayers()
            .every((l) => l.stats.pending === 0),
        null,
        { timeout: 30000, label: "backdrop tiles" }
      )
      await sleep(3000)
      await save(player.page, sc.dir, tag(p.shot))
      await player.page.close()
      await dm.bringToFront()
    }
    checks.ok(
      true,
      `${key} @ ${quality}: editor, DM and ${sc.players.length} player shots`
    )
  } catch (err) {
    checks.fail(`${key} @ ${quality}`, err)
  } finally {
    await context.close()
  }
}

try {
  for (const key of SCENES) {
    if (key === "vineyard" && !fs.existsSync(VINEYARD_FILE)) {
      console.log(
        `  (skipping the vineyard: run e2e/vineyard-build.mjs first to create ${VINEYARD_FILE})`
      )
      continue
    }
    for (const q of QUALITIES) await runScene(key, q)
  }
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
