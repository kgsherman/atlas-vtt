// Move latency on a large, fully daylit open map (local mode). On such a map every sample is lit, so one
// vision compute costs 100–500 ms. A move's result must wait only for the compute of its final position:
// the intermediate steps (which OR into explored) run afterwards as low-priority probes. When each step
// queued a full compute ahead of the result, a 14-step move on a 120×120 field took over 5 s and the
// client expired it as "DM not responding".
//
// The DM creates a generated 120×120-cell daylit field with two PCs, starts a session, two players join;
// player A requests a 20-step move while player B requests a 1-step move at the same time. Both results
// must arrive well under the client's 5 s timeout, and both views must then equal the oracle.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/multiplayer-latency.mjs
//   ATLAS_FIELD=200 …   (field size in cells, default 120; the schema allows up to 200)
import {
  BASE,
  Checks,
  openBrowser,
  seriousErrors,
  waitEditor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  joinGame,
  startSession,
  viewConverges,
} from "./session.mjs"

const SIZE = Number(process.env.ATLAS_FIELD ?? 120)
const LIMIT_MS = 3000
const checks = new Checks("multiplayer-latency")
const logs = []
const browser = await openBrowser()

/** Plan a straight move of `di` cells along X and time it until its result arrives (in the page). */
async function timedMove(page, tokenId, di) {
  return page.evaluate(
    async ({ tokenId, di }) => {
      const p = window.__atlasPlayer
      const s = p.client.getSnapshot()
      const t = s.scene.tokens[tokenId]
      const cs = s.scene.grid.cellSize
      const target = {
        i: Math.floor(t.position.x / cs) + di,
        j: Math.floor(t.position.z / cs),
      }
      const plan = p.planner.plan(tokenId, target, t.levelId)
      if (!plan?.path) return { error: "no path" }
      const t0 = performance.now()
      const reqId = p.client.requestMove(tokenId, plan.path)
      while (performance.now() - t0 < 15000) {
        const res = (p.client.getSnapshot().results ?? []).find(
          (r) => r.reqId === reqId
        )
        if (res)
          return {
            ms: Math.round(performance.now() - t0),
            ok: res.ok,
            reason: res.reason ?? res.local ?? null,
            steps: plan.path.length - 1,
          }
        await new Promise((r) => setTimeout(r, 10))
      }
      return { error: "no result in 15 s" }
    },
    { tokenId, di }
  )
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)

  checks.step(`DM hosts a generated ${SIZE}×${SIZE} daylit field`)
  await dm.goto(`${BASE}/?local=1`, { waitUntil: "domcontentloaded" })
  const made = await dm.evaluate(async (SIZE) => {
    const f = await import("/src/core/scene/factory.ts")
    const m = await import("/src/app/createServices.ts")
    const services = await m.createServices({ mode: "local" })
    const scene = f.createScene({
      name: `E2E open field ${SIZE}`,
      width: SIZE,
      depth: SIZE,
    })
    scene.environment.skyLevel = "bright"
    scene.environment.ambientLevel = "bright"
    const levelId = Object.keys(scene.levels)[0]
    const mid = (SIZE / 2) * 5
    const tokens = []
    for (const [name, x, z] of [
      ["Pip", mid - 50, mid],
      ["Brunhild", mid + 20, mid + 20],
    ]) {
      const t = f.createToken(levelId, { x: x + 2.5, z: z + 2.5 }, { name })
      scene.tokens[t.id] = t
      tokens.push({ id: t.id, name })
    }
    const summary = await services.scenes.create(scene)
    return { sceneId: summary.id, tokens }
  }, SIZE)
  await dm.goto(`${BASE}/editor/${made.sceneId}?local=1`, {
    waitUntil: "domcontentloaded",
  })
  await waitEditor(dm, 60000)
  const h0 = await startSession(dm)
  checks.ok(true, `hosting ${h0.roomCode}`)

  checks.step("Two players join; each gets a character")
  const A = await joinGame(context, {
    roomCode: h0.roomCode,
    name: "Morgana",
    logs,
  })
  const B = await joinGame(context, {
    roomCode: h0.roomCode,
    name: "Theron",
    logs,
  })
  const [tokA, tokB] = made.tokens
  await assignToken(dm, A, tokA)
  await assignToken(dm, B, tokB)
  checks.ok(
    true,
    `${A.name} controls ${tokA.name}, ${B.name} controls ${tokB.name}`
  )

  checks.step("A 20-step move and another player's 1-step move at once")
  const [ra, rb] = await Promise.all([
    timedMove(A.page, tokA.id, 20),
    timedMove(B.page, tokB.id, 1),
  ])
  console.log(`   A: ${JSON.stringify(ra)}\n   B: ${JSON.stringify(rb)}`)
  checks.ok(
    ra.ok === true && ra.steps === 20 && ra.ms < LIMIT_MS,
    `${A.name}'s 20-step move is answered in ${ra.ms} ms (< ${LIMIT_MS} ms)`,
    ra
  )
  checks.ok(
    rb.ok === true && rb.ms < LIMIT_MS,
    `${B.name}'s concurrent 1-step move is answered in ${rb.ms} ms (< ${LIMIT_MS} ms)`,
    rb
  )
  for (const p of [A, B])
    checks.eq(
      await viewConverges(dm, p.page, p.uid, 20000),
      [],
      `${p.name}'s view equals the oracle (step exploration included)`
    )
} catch (err) {
  checks.fail("multiplayer-latency crashed", err)
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
