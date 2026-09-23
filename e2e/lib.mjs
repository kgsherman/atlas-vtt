// Shared helpers for the end-to-end scripts in e2e/ (plain Node + Playwright, no test runner).
//
//   ATLAS_URL  dev server origin (default http://127.0.0.1:5173; start one with `npx vite`)
//   ATLAS_GPU  "nvidia" | "amd" | "swiftshader" (default nvidia; see scripts/pw.mjs)
//   ATLAS_OUT  directory for screenshots and logs (default $TMPDIR/atlas-e2e/<script>)
//
// Every script exits non-zero when a check fails, and prints one line per check.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { chromium, HEADLESS_SHELL, launchOptions } from "../scripts/pw.mjs"

export const BASE = (process.env.ATLAS_URL ?? "http://127.0.0.1:5173").replace(
  /\/$/,
  ""
)
export const GPU = process.env.ATLAS_GPU ?? "nvidia"
export const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
)
export const TEST_MAPS = path.join(REPO, "test_maps")

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Output directory for one script (created on demand). */
export function outDir(name) {
  const dir = process.env.ATLAS_OUT ?? path.join(os.tmpdir(), "atlas-e2e", name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---- checks -------------------------------------------------------------------------------------

/** Collects pass/fail lines; `done()` prints a summary and sets the exit code. */
export class Checks {
  constructor(name) {
    this.name = name
    this.failures = []
    this.passes = 0
    this.t0 = performance.now()
  }

  ok(cond, label, detail) {
    if (cond) {
      this.passes++
      console.log(`  ✓ ${label}`)
    } else {
      this.failures.push(label)
      console.log(
        `  ✗ ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`
      )
    }
    return !!cond
  }

  eq(actual, expected, label) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    return this.ok(a === e, label, a === e ? undefined : `got ${a}, want ${e}`)
  }

  step(title) {
    const now = performance.now()
    const lap =
      this.lap === undefined
        ? ""
        : ` (previous step ${((now - this.lap) / 1000).toFixed(1)} s)`
    this.lap = now
    console.log(`\n▸ ${title}${lap}`)
  }

  fail(label, err) {
    this.failures.push(label)
    console.log(`  ✗ ${label} — ${err?.stack ?? err}`)
  }

  done() {
    const s = ((performance.now() - this.t0) / 1000).toFixed(1)
    if (this.failures.length === 0)
      console.log(`\n${this.name}: all ${this.passes} checks passed (${s} s)`)
    else
      console.log(
        `\n${this.name}: ${this.failures.length} FAILED, ${this.passes} passed (${s} s)\n  - ${this.failures.join("\n  - ")}`
      )
    process.exitCode = this.failures.length === 0 ? 0 : 1
  }
}

// ---- browser --------------------------------------------------------------------------------------

/**
 * Launch the shared headless Chromium (scripts/pw.mjs). By default frames are capped by vsync: with
 * several tabs rendering uncapped (the launcher's benchmarking flags) the GPU is saturated and a newly
 * opened tab can take 15 s to get its first frames. Pass `{ uncapped: true }` for frame-time measurements.
 */
export async function openBrowser({ backend = GPU, uncapped = false } = {}) {
  const o = launchOptions(backend)
  const args = uncapped
    ? o.args
    : o.args.filter(
        (a) => a !== "--disable-gpu-vsync" && a !== "--disable-frame-rate-limit"
      )
  return chromium.launch({
    headless: true,
    executablePath: HEADLESS_SHELL,
    args,
    env: o.env,
  })
}

/** Log console errors / warnings and page errors of a page into `sink` (tagged). */
export function watchPage(page, tag, sink) {
  page.on("console", (m) => {
    const t = m.type()
    if (t === "error" || t === "warning") sink.push(`[${tag} ${t}] ${m.text()}`)
  })
  page.on("pageerror", (e) => sink.push(`[${tag} pageerror] ${e.message}`))
}

/**
 * Errors worth failing on. Drops known-benign noise: GPU driver chatter, favicon 404s, and the browser's
 * own network log of 400/404 (expected "not there yet" answers) and 429 (Storage rate limiting, which
 * the app retries with back-off — count those with rateLimited()).
 */
export function seriousErrors(logs) {
  return logs.filter(
    (l) =>
      (l.includes(" error]") || l.includes("pageerror]")) &&
      !/GL_INVALID|GPU stall|WebGL: |favicon|Failed to load resource: the server responded with a status of (40[04]|429)/.test(
        l
      )
  )
}

/** Requests the backend rate-limited (HTTP 429), as logged by the browser. */
export function rateLimited(logs) {
  return logs.filter((l) => l.includes("status of 429")).length
}

export async function waitFor(
  page,
  fn,
  arg,
  { timeout = 20000, label = "condition" } = {}
) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 })
  } catch (e) {
    throw new Error(
      `timed out waiting for ${label} (${timeout} ms): ${String(e.message).split("\n")[0]}`,
      { cause: e }
    )
  }
}

export async function shot(page, dir, name) {
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---- editor ---------------------------------------------------------------------------------------

/** Wait until the editor page exposes its dev automation handle with a live engine. */
export async function waitEditor(page, timeout = 30000) {
  await waitFor(page, () => window.__atlasEditor?.engine != null, null, {
    timeout,
    label: "editor engine",
  })
  await sleep(400)
}

/** Client (CSS px) coordinates of a world point on the active level (y defaults to its ground). */
export async function editorToClient(page, x, z, y = null) {
  return page.evaluate(
    ([x, z, y]) => {
      const { engine, store } = window.__atlasEditor
      const s = store.getState()
      const lvl = s.scene.levels[s.activeLevelId]
      const p = engine.project({ x, y: y ?? lvl.elevation, z })
      const r = document
        .querySelector("canvas[data-slot=engine-canvas]")
        .getBoundingClientRect()
      return { x: r.left + p.x, y: r.top + p.y, visible: p.visible }
    },
    [x, z, y]
  )
}

export async function clickWorld(page, x, z, opts = {}) {
  const p = await editorToClient(page, x, z)
  await page.mouse.move(p.x, p.y, { steps: 2 })
  await sleep(30)
  await page.mouse.click(p.x, p.y, opts)
  await sleep(50)
}

export async function dragWorld(page, [ax, az], [bx, bz]) {
  const p = await editorToClient(page, ax, az)
  const q = await editorToClient(page, bx, bz)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 })
  await page.mouse.move(q.x, q.y, { steps: 4 })
  await sleep(40)
  await page.mouse.up()
  await sleep(60)
}

/** Summary of the editor document: object counts per type, tokens, levels, history, save state. */
export async function editorSummary(page) {
  return page.evaluate(() => {
    const s = window.__atlasEditor.store.getState()
    const objects = {}
    for (const o of Object.values(s.scene.objects))
      objects[o.type] = (objects[o.type] ?? 0) + 1
    return {
      name: s.scene.name,
      objects,
      tokens: Object.keys(s.scene.tokens).length,
      levels: Object.values(s.scene.levels)
        .sort((a, b) => a.elevation - b.elevation)
        .map((l) => l.name),
      dirty: s.dirty,
      undo: s.history.undoLabel,
      redo: s.history.redoLabel,
      rejected: s.lastRejected,
      path: location.pathname,
    }
  })
}

/** Paths where two JSON values differ (for readable assertion failures), at most `limit`. */
export function jsonDiff(a, b, limit = 10, prefix = "", out = []) {
  if (out.length >= limit || JSON.stringify(a) === JSON.stringify(b)) return out
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    out.push(
      `${prefix || "."}: ${JSON.stringify(a)?.slice(0, 120)} → ${JSON.stringify(b)?.slice(0, 120)}`
    )
    return out
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    jsonDiff(a[k], b[k], limit, `${prefix}.${k}`, out)
  return out
}
