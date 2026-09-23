// Frame-time measurements of the DM console and a player's view, per GPU / quality tier and scene
// (local mode, 1920×1080):
//   - "vsync": the engine's own FrameStats over 5 s with the display's 60 Hz frame pacing, as on a real
//     laptop (fps and p95 frame interval: 60 / 16.7 ms means the frame budget holds);
//   - "GPU": engine.benchmark(120) — frames rendered back to back, each followed by a 1-pixel readPixels,
//     so the time includes the GPU work (median and p95: the headroom against the 16.7 ms budget).
// ATLAS_UNCAPPED=1 measures the first set with frame pacing off instead. On an integrated GPU that
// mostly measures queue saturation (the driver blocks for 100–300 ms whenever its queue fills up), so
// the default is vsync.
// While the player is measured, the DM tab (which hosts the game) keeps running but stops rendering
// (engine.debugPause), so one renderer has the GPU.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/perf.mjs
//   ATLAS_PERF="amd:medium,nvidia:ultra"  ATLAS_SCENES="vineyard,stress"   (defaults)
import fs from "node:fs"
import path from "node:path"

import { Checks, openBrowser, outDir, sleep, TEST_MAPS } from "./lib.mjs"
import {
  assignToken,
  joinGame,
  openSceneInEditor,
  startSession,
} from "./session.mjs"

const OUT = outDir("perf")
const RUNS = (process.env.ATLAS_PERF ?? "amd:medium,nvidia:ultra")
  .split(",")
  .map((s) => s.split(":"))
const SCENES = (process.env.ATLAS_SCENES ?? "vineyard,stress").split(",")
const VINEYARD_FILE = path.join(TEST_MAPS, "vineyard.atlas.json")
const OPEN = {
  vineyard: { file: VINEYARD_FILE },
  stress: { sample: "Stress Test" },
  crooked: { sample: "The Crooked Lantern" },
}
const checks = new Checks("perf")
const rows = []

/** Freeze the tier, let shaders compile and shadow tiles settle, then measure. */
async function measure(page, handle, quality) {
  await page.evaluate(
    ({ handle, quality }) => {
      const e = window[handle].engine
      e.debugFreezeQuality?.(true)
      e.setQuality(quality)
    },
    { handle, quality }
  )
  await sleep(4000)
  const free = await page.evaluate(async (handle) => {
    const e = window[handle].engine
    const frames = []
    let last = null
    const off = e.onFrame((s) => {
      frames.push(s.frameMs)
      last = s
    })
    await new Promise((r) => setTimeout(r, 5000))
    off()
    const sorted = frames.slice().sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    return {
      frames: frames.length,
      fps: frames.length / 5,
      p95,
      drawCalls: last?.drawCalls,
      lights: last?.activeLights,
      tiles: last?.shadowTilesTotal,
      pixelRatio: last?.pixelRatio,
      quality: last?.quality,
    }
  }, handle)
  const sync = await page.evaluate(
    (handle) => window[handle].engine.benchmark?.(120) ?? null,
    handle
  )
  return { free, sync }
}

for (const [gpu, quality] of RUNS) {
  const browser = await openBrowser({
    backend: gpu,
    uncapped: process.env.ATLAS_UNCAPPED === "1",
  })
  try {
    for (const scene of SCENES) {
      if (scene === "vineyard" && !fs.existsSync(VINEYARD_FILE)) {
        console.log(
          "  (skipping the vineyard: run e2e/vineyard-build.mjs first)"
        )
        continue
      }
      checks.step(`${gpu} · ${quality} · ${scene}`)
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      })
      try {
        const dm = await context.newPage()
        await openSceneInEditor(dm, { mode: "local", ...OPEN[scene] })
        const session = await startSession(dm)
        await dm.evaluate(() => window.__atlasHost.engine.frameScene())
        const dmResult = await measure(dm, "__atlasHost", quality)
        await dm.screenshot({
          path: path.join(OUT, `${gpu}-${quality}-${scene}-dm.png`),
        })

        const tokens = Object.values(session.state.scene.tokens).filter(
          (t) => !t.hidden
        )
        const token = tokens.find((t) => t.kind === "pc") ?? tokens[0]
        // The DM tab keeps hosting but stops rendering while the player is measured.
        await dm.evaluate(() => window.__atlasHost.engine.debugPause?.(true))
        const player = await joinGame(context, {
          roomCode: session.roomCode,
          name: "Perf",
        })
        await assignToken(dm, player, token)
        await player.page.bringToFront()
        await player.page.evaluate(
          (id) => window.__atlasPlayer.select(id),
          token.id
        )
        const plResult = await measure(player.page, "__atlasPlayer", quality)
        await player.page.screenshot({
          path: path.join(OUT, `${gpu}-${quality}-${scene}-player.png`),
        })

        for (const [view, r] of [
          ["DM", dmResult],
          ["player", plResult],
        ]) {
          const row = {
            gpu,
            quality,
            scene,
            view,
            fps: +r.free.fps.toFixed(0),
            p95: +r.free.p95.toFixed(1),
            syncMedian: +(r.sync?.medianMs ?? 0).toFixed(1),
            syncP95: +(r.sync?.p95Ms ?? 0).toFixed(1),
            draws: r.free.drawCalls,
            lights: r.free.lights,
            dpr: r.free.pixelRatio,
            tier: r.free.quality,
          }
          rows.push(row)
          console.log(
            `  ${view.padEnd(6)} ${String(row.fps).padStart(4)} fps · p95 ${row.p95} ms · GPU frame median ${row.syncMedian} ms / p95 ${row.syncP95} ms · ${row.draws} draws · ${row.lights} lights · tier ${row.tier}`
          )
          checks.ok(
            row.tier === quality,
            `${view}: engine held the ${quality} tier`,
            row.tier
          )
          checks.ok(
            row.syncP95 <= 16.7,
            `${view}: GPU frame p95 within the 16.7 ms budget`,
            `${row.syncP95} ms`
          )
          if (process.env.ATLAS_UNCAPPED !== "1")
            checks.ok(
              row.fps >= 57 && row.p95 <= 18,
              `${view}: steady 60 fps with vsync`,
              `${row.fps} fps, p95 ${row.p95} ms`
            )
        }
      } catch (err) {
        checks.fail(`${gpu} ${quality} ${scene}`, err)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
}

fs.writeFileSync(path.join(OUT, "perf.json"), JSON.stringify(rows, null, 2))
const pacing = process.env.ATLAS_UNCAPPED === "1" ? "uncapped" : "vsync"
console.log(
  `\n| GPU | tier | scene | view | fps (${pacing}) | p95 ms (${pacing}) | GPU frame median ms | GPU frame p95 ms | draws |`
)
console.log("|---|---|---|---|---|---|---|---|---|")
for (const r of rows)
  console.log(
    `| ${r.gpu} | ${r.quality} | ${r.scene} | ${r.view} | ${r.fps} | ${r.p95} | ${r.syncMedian} | ${r.syncP95} | ${r.draws} |`
  )
checks.done()
