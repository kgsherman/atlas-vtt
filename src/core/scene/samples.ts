/**
 * Built-in sample scenes: a showcase tavern exercising every feature of the scene model, a stress
 * scene for performance work (docs/PERFORMANCE.md) and an empty scene. Each build() returns a fresh
 * document with fresh ids.
 */
import {
  createConnector,
  createDoor,
  createFloor,
  createLevel,
  createLight,
  createPillar,
  createProp,
  createScene,
  createToken,
  createWall,
  createWindow,
  defaultEnvironment,
} from "./factory"
import { createHeightmap, sampleCounts, sampleSpacing, writeHeights } from "./heightmap"
import { wallDirection } from "./queries"
import type {
  DoorObject,
  DoorState,
  DoorStyle,
  FloorObject,
  Id,
  Level,
  LightObject,
  LightPreset,
  MaterialId,
  PillarObject,
  PropKind,
  PropObject,
  Rect,
  Scene,
  SceneObject,
  Token,
  Vec2,
  WallObject,
  WindowObject,
} from "./types"

export interface SampleScene {
  id: string
  name: string
  description: string
  build(): Scene
}

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

type XZ = [number, number]

const v = ([x, z]: XZ): Vec2 => ({ x, z })
const rect = (x: number, z: number, w: number, d: number): Rect => ({ x, z, w, d })

function builder(scene: Scene) {
  const add = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  return {
    add,
    level(partial: Partial<Level>): Level {
      const level = createLevel(partial)
      scene.levels[level.id] = level
      return level
    },
    floor(levelId: Id, r: Rect, material: MaterialId, partial: Partial<FloorObject> = {}): FloorObject {
      return add({ ...createFloor(levelId, r, material), ...partial })
    },
    wall(levelId: Id, a: XZ, b: XZ, partial: Partial<WallObject> = {}): WallObject {
      return add(createWall(levelId, v(a), v(b), partial))
    },
    /** Consecutive walls through the points (sharing endpoints, so corners join); `closed` adds last→first. */
    walls(levelId: Id, points: XZ[], partial: Partial<WallObject> = {}, closed = false): WallObject[] {
      const out: WallObject[] = []
      const n = closed ? points.length : points.length - 1
      for (let k = 0; k < n; k++) out.push(add(createWall(levelId, v(points[k]), v(points[(k + 1) % points.length]), partial)))
      return out
    },
    /** Door centred on the point of the wall closest to `at`. */
    door(wall: WallObject, at: XZ, partial: Partial<DoorObject> = {}): DoorObject {
      return add(createDoor(wall, offsetAt(wall, at), partial))
    },
    window(wall: WallObject, at: XZ, partial: Partial<WindowObject> = {}): WindowObject {
      return add(createWindow(wall, offsetAt(wall, at), partial))
    },
    pillar(levelId: Id, at: XZ, partial: Partial<PillarObject> = {}): PillarObject {
      return add(createPillar(levelId, v(at), partial))
    },
    prop(levelId: Id, kind: PropKind, at: XZ, partial: Partial<PropObject> = {}): PropObject {
      return add(createProp(levelId, kind, { x: at[0], y: 0, z: at[1] }, partial))
    },
    light(levelId: Id, preset: LightPreset, at: XZ, y?: number, partial: Partial<LightObject> = {}): LightObject {
      const light = createLight(levelId, preset, v(at), partial)
      if (y !== undefined) light.position = { ...light.position, y }
      return add(light)
    },
    token(levelId: Id, at: XZ, partial: Partial<Token>): Token {
      const t = createToken(levelId, v(at), partial)
      scene.tokens[t.id] = t
      return t
    },
  }
}

/** Distance along a→b of the projection of `at` onto the wall. */
function offsetAt(wall: WallObject, [x, z]: XZ): number {
  const d = wallDirection(wall)
  return (x - wall.a.x) * d.x + (z - wall.a.z) * d.z
}

/** Deterministic PRNG (mulberry32) so procedurally built samples are identical on every build. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// The Crooked Lantern
// ---------------------------------------------------------------------------

/*
 * Layout (feet; grid 40×30 cells of 5 ft = 200×150). The tavern occupies x 30–110, z 30–90; the
 * walled courtyard lies east of it (x 110–160). Exterior walls are 0.5 ft thick; slabs of the upper
 * storeys stop at the inner wall faces (±0.25) so wall tops and slab tops never overlap.
 *
 *  CELLAR (−10)   main cellar x30–70 z30–60, smugglers' cache x70–85 z30–45 behind a secret door,
 *                 ladder at cell (7,7) up into the kitchen.
 *  GROUND (0)     kitchen x30–55 z30–50, pantry x55–75 z30–50 (locked), stair hall x75–110 z30–50 with
 *                 the stairs x80–100 z30–40 climbing east (+X) to a landing at x100–105 upstairs,
 *                 common room x30–110 z50–90 (fireplace west, bar east), front door south (x 70),
 *                 courtyard door east (z 85). Courtyard: 3 ft garden wall with a gate gap in the east side.
 *                 Terrain: one gentle hill in the south-east meadow (outside everything else).
 *  UPPER (10)     bedrooms N1 x30–55, N2 x55–80 (z30–50), landing x80–110 z30–50 around the stairwell,
 *                 corridor z50–60, bedrooms S1 x30–60, S2 (wizard, magical light) x60–85, S3 x85–110
 *                 (z60–90); balcony x110–125 z45–70 over the courtyard with a 3.5 ft railing, where
 *                 the fighter stands at the railing with a lantern.
 *  ROOF (20)      slab over the footprint, 2.5 ft parapet, chimney.
 */
function buildCrookedLantern(): Scene {
  const scene = createScene({ name: "The Crooked Lantern", width: 40, depth: 30, groundFloor: false })
  const b = builder(scene)
  const ground = Object.values(scene.levels)[0]
  ground.name = "Ground Floor"
  const cellar = b.level({ name: "Cellar", elevation: -10, height: 10 })
  const upper = b.level({ name: "Upper Floor", elevation: 10, height: 10 })
  const roof = b.level({ name: "Roof", elevation: 20, height: 10 })

  scene.environment = {
    ...defaultEnvironment(),
    skyLevel: "dim",
    ambientLevel: "dark",
    ambientColor: "#7a88b0",
    ambientIntensity: 0.1,
    directional: {
      enabled: true,
      kind: "moon",
      azimuth: Math.PI * 0.72,
      elevation: Math.PI * 0.32,
      color: "#a9bcff",
      intensity: 0.4,
      grants: "dim",
    },
    backgroundColor: "#080a11",
  }
  scene.meta = { tags: ["sample", "tavern", "multi-level", "night"] }

  const EXT = { thickness: 0.5 }
  const G = ground.id
  const C = cellar.id
  const U = upper.id
  const R = roof.id

  // ------------------------------------------------------------------ cellar
  b.floor(C, rect(30, 30, 40, 30), "stone", { name: "Cellar floor" })
  b.floor(C, rect(70, 30, 15, 15), "stone", { name: "Smugglers' cache floor" })
  const cellarWall = { height: 9, material: "stone" as const, thickness: 0.75 }
  b.walls(C, [[30, 60], [30, 30], [85, 30], [85, 45], [70, 45]], cellarWall)
  const cellarEast = b.wall(C, [70, 30], [70, 60], cellarWall)
  b.wall(C, [70, 60], [30, 60], cellarWall)
  b.door(cellarEast, [70, 37.5], { style: "secret", state: "closed", name: "Secret door (loose stones)", dmNotes: "DC 15 Perception to notice the draught." })
  b.add(createConnector(C, G, rect(35, 35, 5, 5), 0, "ladder"))
  for (const x of [34, 37, 40, 43]) b.prop(C, "barrel", [x, 57.5])
  for (const z of [45, 48, 51]) b.prop(C, "barrel", [32, z])
  b.prop(C, "crate", [65, 55])
  b.prop(C, "crate", [65, 55], { position: { x: 65, y: 3, z: 55 }, rotationY: 0.3 })
  b.prop(C, "crate", [61.5, 55], { rotationY: -0.15 })
  b.prop(C, "crate", [65, 51.5], { rotationY: 0.1 })
  b.prop(C, "table", [79, 37.5], { name: "Smugglers' table" })
  b.prop(C, "chair", [79, 41])
  b.prop(C, "chest", [82.5, 42.5], { name: "Contraband chest", dmNotes: "300 gp of untaxed brandy labels." })
  b.prop(C, "crate", [73.5, 33.5])
  b.light(C, "candle", [79, 37.5], 2.8, { name: "Guttering candle" })

  // ------------------------------------------------------------------ ground: floors
  b.floor(G, rect(30, 30, 25, 20), "tile", { name: "Kitchen floor" })
  b.floor(G, rect(55, 30, 55, 20), "wood", { name: "Pantry & stair hall floor" })
  b.floor(G, rect(30, 50, 80, 40), "wood", { name: "Common room floor" })
  b.floor(G, rect(110, 30, 50, 60), "dirt", { name: "Courtyard" })
  b.floor(G, rect(0, 0, 200, 30), "grass")
  b.floor(G, rect(0, 30, 30, 60), "grass")
  b.floor(G, rect(160, 30, 40, 60), "grass")
  b.floor(G, rect(0, 90, 65, 60), "grass")
  b.floor(G, rect(65, 90, 10, 60), "cobble", { name: "Road" })
  b.floor(G, rect(75, 90, 125, 60), "grass")

  // ------------------------------------------------------------------ ground: walls & openings
  const gExt = { ...EXT, height: 10, material: "stone" as const }
  const [gN, gE, gS, gW] = b.walls(G, [[30, 30], [110, 30], [110, 90], [30, 90]], gExt, true)
  b.window(gN, [42.5, 30])
  b.window(gN, [65, 30])
  b.window(gN, [105, 30])
  b.window(gE, [110, 45])
  b.door(gE, [110, 85], { state: "open", name: "Courtyard door", swing: -1 })
  b.door(gS, [70, 90], { width: 6, leaves: "double", state: "closed", name: "Front door" })
  b.window(gS, [92.5, 90])
  b.window(gS, [50, 90])
  b.window(gW, [30, 80])
  b.window(gW, [30, 55])
  b.window(gW, [30, 40])

  const gInt = { height: 9, thickness: 0.5, material: "wood" as const }
  const kitchenSouth = b.wall(G, [30, 50], [75, 50], gInt)
  b.wall(G, [55, 30], [55, 50], gInt)
  b.wall(G, [75, 30], [75, 50], gInt)
  b.wall(G, [80, 40], [100, 40], { ...gInt, material: "plaster", name: "Stair wall" })
  b.door(kitchenSouth, [42.5, 50], { state: "open", name: "Kitchen door" })
  b.door(kitchenSouth, [65, 50], { state: "locked", style: "iron", name: "Pantry door", dmNotes: "The barkeep has the key." })

  // Stairs: 4 cells long (x 80–100) × 2 cells wide, climbing +X; landing upstairs at x 100–105.
  b.add({ ...createConnector(G, U, rect(80, 30, 20, 10), 1, "stairs"), name: "Stairs" })

  // ------------------------------------------------------------------ ground: kitchen, pantry, stair hall
  b.prop(G, "table", [47.5, 40], { rotationY: Math.PI / 2, name: "Prep table" })
  b.prop(G, "barrel", [52.5, 32.5])
  b.prop(G, "barrel", [52.5, 35.5], { color: "#5d3d22" })
  b.prop(G, "crate", [33, 47])
  b.light(G, "lantern", [45, 45], 7, { name: "Kitchen lantern" })

  b.prop(G, "crate", [58.5, 33.5])
  b.prop(G, "crate", [58.5, 37], { rotationY: 0.2 })
  b.prop(G, "crate", [62, 33.5], { rotationY: -0.1 })
  b.prop(G, "barrel", [72, 33])
  b.prop(G, "barrel", [72, 36])
  b.prop(G, "barrel", [69, 33])
  b.prop(G, "chest", [70, 46], { name: "Strongbox" })

  b.prop(G, "crate", [104, 33])
  b.prop(G, "barrel", [107.5, 32.5])

  // ------------------------------------------------------------------ ground: common room
  b.pillar(G, [31.75, 65], { shape: "square", size: 3, height: 9, material: "stone", name: "Chimney breast" })
  b.light(G, "brazier", [34.6, 65], 2.5, { name: "Hearth fire" })
  b.prop(G, "chair", [38.5, 60.5], { rotationY: -0.6 })
  b.prop(G, "chair", [38.5, 69.5], { rotationY: 0.6 })
  b.pillar(G, [57.5, 67.5], { shape: "round", size: 1.5, height: 9, material: "wood" })
  b.pillar(G, [82.5, 67.5], { shape: "round", size: 1.5, height: 9, material: "wood" })

  const tableSet = (at: XZ, chairs: XZ[], rotationY = 0) => {
    b.prop(G, "table", at, { rotationY })
    for (const c of chairs) b.prop(G, "chair", c, { rotationY: Math.atan2(at[0] - c[0], at[1] - c[1]) })
  }
  tableSet([47.5, 58], [[47.5, 55], [47.5, 61]])
  tableSet([45, 77.5], [[45, 74.5], [45, 80.5], [41, 77.5]])
  tableSet([57.5, 80], [[57.5, 77], [57.5, 83]])
  tableSet([85, 82], [[85, 79], [85, 85], [89, 82]])
  tableSet([70, 58], [[70, 55], [70, 61]])

  // Bar counter (two stretched tables) with stools, back shelf and kegs.
  const barTop = { rotationY: Math.PI / 2, scale: { x: 2, y: 1.4, z: 0.8 }, color: "#5a3a22", name: "Bar" }
  b.prop(G, "table", [97.5, 60], barTop)
  b.prop(G, "table", [97.5, 70], barTop)
  for (const z of [58, 63, 68, 73]) b.prop(G, "chair", [94, z], { scale: { x: 1, y: 1.1, z: 1 } })
  b.prop(G, "bookshelf", [108.75, 65], { rotationY: Math.PI / 2, name: "Bottle shelf", color: "#4a2e1a" })
  b.prop(G, "barrel", [107.5, 57.5])
  b.prop(G, "barrel", [107.5, 73])
  b.light(G, "lantern", [102.5, 62.5], 7.5, { name: "Bar lantern" })
  b.light(G, "torch", [60, 50.6], 6, { name: "Sconce (north)" })
  b.light(G, "torch", [88, 89.4], 6, { name: "Sconce (south)" })

  // ------------------------------------------------------------------ ground: outdoors
  const lowWall = { height: 3, thickness: 1, material: "stone" as const, name: "Garden wall" }
  b.walls(G, [[110, 30], [160, 30], [160, 55]], lowWall)
  b.walls(G, [[160, 65], [160, 90], [110, 90]], lowWall)
  b.prop(G, "well", [140, 42.5])
  b.prop(G, "tree", [150, 80], { name: "Old oak" })
  b.prop(G, "bush", [117.5, 84])
  b.light(G, "lantern", [110.6, 80], 7, { name: "Courtyard lantern" })
  b.light(G, "torch", [64, 90.6], 6, { name: "Door torch (west)" })
  b.light(G, "torch", [76, 90.6], 6, { name: "Door torch (east)" })

  for (const at of [[12, 14], [22, 136], [188, 14], [40, 118], [120, 130]] as XZ[]) b.prop(G, "tree", at)
  b.prop(G, "bush", [61, 97])
  b.prop(G, "bush", [79, 97])
  b.prop(G, "cart", [86, 112], { rotationY: 0.25 })
  b.prop(G, "rock", [172, 134])
  b.prop(G, "rock", [188, 121], { scale: { x: 0.7, y: 0.6, z: 0.7 } })

  // A gentle hill in the south-east meadow (zero everywhere else, so buildings stay level).
  const hm = createHeightmap(2)
  const { samplesX, samplesZ } = sampleCounts(scene.grid, hm.resolution)
  const spacing = sampleSpacing(scene.grid.cellSize, hm.resolution)
  const dense = new Float32Array(samplesX * samplesZ)
  const hill = { x: 178, z: 128, r: 26, peak: 5 }
  for (let sz = 0; sz < samplesZ; sz++) {
    for (let sx = 0; sx < samplesX; sx++) {
      const d = Math.hypot(sx * spacing - hill.x, sz * spacing - hill.z)
      if (d < hill.r) dense[sz * samplesX + sx] = hill.peak * (0.5 + 0.5 * Math.cos((Math.PI * d) / hill.r))
    }
  }
  ground.heightmap = writeHeights(hm, scene.grid, dense)

  // ------------------------------------------------------------------ upper floor
  b.floor(U, rect(30.25, 30.25, 79.5, 59.5), "wood", { name: "Upper floor" })
  b.floor(U, rect(110.25, 45, 14.75, 25), "wood", { name: "Balcony" })
  const uExt = { ...EXT, height: 10, material: "plaster" as const }
  const [uN, uE, uS, uW] = b.walls(U, [[30, 30], [110, 30], [110, 90], [30, 90]], uExt, true)
  b.window(uN, [42.5, 30])
  b.window(uN, [67.5, 30])
  b.window(uN, [105, 30])
  b.window(uE, [110, 40])
  b.door(uE, [110, 55], { state: "open", name: "Balcony door" })
  b.window(uE, [110, 77.5])
  b.window(uS, [97.5, 90])
  b.window(uS, [72.5, 90])
  b.window(uS, [45, 90])
  b.window(uW, [30, 80])
  b.window(uW, [30, 40])

  const uInt = { height: 9, thickness: 0.5, material: "wood" as const }
  const northRooms = b.wall(U, [30, 50], [80, 50], uInt)
  b.wall(U, [55, 30], [55, 50], uInt)
  b.wall(U, [80, 30], [80, 50], uInt)
  const southRooms = b.wall(U, [30, 60], [110, 60], uInt)
  b.wall(U, [60, 60], [60, 90], uInt)
  b.wall(U, [85, 60], [85, 90], uInt)
  const railing = { height: 3.5, thickness: 0.3, material: "wood" as const, name: "Railing" }
  b.wall(U, [80, 40], [100, 40], railing)
  b.walls(U, [[110, 45], [125, 45], [125, 70], [110, 70]], railing)
  // Bedroom doors swing into the rooms (north rooms: −normal side of a west→east wall).
  b.door(northRooms, [42.5, 50], { state: "closed", name: "Room 1", swing: -1 })
  b.door(northRooms, [67.5, 50], { state: "open", name: "Room 2", swing: -1 })
  b.door(southRooms, [45, 60], { state: "closed", name: "Room 3" })
  b.door(southRooms, [72.5, 60], { state: "locked", name: "Wizard's room" })
  b.door(southRooms, [97.5, 60], { state: "open", name: "Room 5" })

  b.pillar(U, [31.75, 65], { shape: "square", size: 3, height: 9, material: "stone", name: "Chimney" })
  b.prop(U, "bed", [35, 36])
  b.prop(U, "chest", [35, 42])
  b.prop(U, "bed", [60, 36])
  b.prop(U, "chest", [60, 42])
  b.prop(U, "bookshelf", [78.9, 42], { rotationY: Math.PI / 2 })
  b.prop(U, "chair", [106, 46])
  b.prop(U, "bed", [40, 82])
  b.prop(U, "bed", [50, 82])
  b.prop(U, "table", [45, 70])
  b.prop(U, "chair", [45, 73.5], { rotationY: Math.PI })
  b.prop(U, "bed", [80, 82], { color: "#4b3a6e" })
  b.prop(U, "bookshelf", [61.6, 72], { rotationY: Math.PI / 2 })
  b.prop(U, "bookshelf", [61.6, 77], { rotationY: Math.PI / 2 })
  b.prop(U, "table", [77, 70], { name: "Wizard's desk" })
  b.prop(U, "chair", [77, 73.5], { rotationY: Math.PI })
  b.prop(U, "bed", [104, 82])
  b.prop(U, "chest", [104, 75.5])
  b.prop(U, "table", [114.5, 66], { scale: { x: 0.6, y: 0.6, z: 0.6 } })
  b.prop(U, "chair", [118, 66], { rotationY: -Math.PI / 2 })
  b.prop(U, "chair", [114.5, 62.5])
  b.light(U, "lantern", [55, 55], 7, { name: "Corridor lantern" })
  b.light(U, "torch", [80.6, 45], 6, { name: "Landing sconce" })
  b.light(U, "magical", [68, 76], 7, { name: "Floating orb" })
  b.light(U, "candle", [104, 75.5], 2.3, { name: "Bedside candle" })

  // ------------------------------------------------------------------ roof
  b.floor(R, rect(30.25, 30.25, 79.5, 59.5), "tile", { name: "Roof" })
  b.walls(R, [[30, 30], [110, 30], [110, 90], [30, 90]], { height: 2.5, thickness: 0.5, material: "stone", name: "Parapet" }, true)
  b.pillar(R, [31.75, 65], { shape: "square", size: 3, height: 5, material: "stone", name: "Chimney" })

  // ------------------------------------------------------------------ tokens
  b.token(G, [152.5, 47.5], {
    name: "Pip Thistledown",
    label: "Pip",
    kind: "pc",
    size: "small",
    vision: { darkvision: 60, blindsight: 0, blind: false },
    speed: 25,
    color: "#52c060",
    dmNotes: "Halfling rogue. Eye height 3 ft: cannot see over the 3 ft garden wall.",
  })
  // The fighter leans on the balcony railing (eye 5.5 ft over a 3.5 ft railing) with a lantern,
  // looking down into the courtyard.
  const fighter = b.token(U, [122.5, 57.5], {
    name: "Ser Aldric Vane",
    label: "Aldric",
    kind: "pc",
    size: "medium",
    speed: 30,
    color: "#52b0e0",
    dmNotes: "On the balcony: sees over the railing down into the courtyard (beyond ~18 ft from the railing).",
  })
  b.light(U, "lantern", [0.6, 0], 3.5, { attachedTokenId: fighter.id, name: "Aldric's lantern" })
  b.token(G, [72.5, 67.5], {
    name: "Brunhild Ironvein",
    label: "Brunhild",
    kind: "pc",
    size: "medium",
    height: 4.5,
    eyeHeight: 4,
    vision: { darkvision: 60, blindsight: 0, blind: false },
    speed: 25,
    color: "#e0a052",
    dmNotes: "Dwarf cleric in the common room.",
  })
  b.token(G, [137.5, 72.5], {
    name: "Hill Giant",
    label: "Hill Giant",
    kind: "monster",
    size: "huge",
    speed: 40,
    color: "#8a6d4a",
    dmNotes: "Eye height 14 ft: sees straight over the garden wall.",
  })
  const bandit = b.token(G, [167.5, 47.5], {
    name: "Bandit Lookout",
    label: "Bandit",
    kind: "monster",
    size: "medium",
    hidden: true,
    speed: 30,
    color: "#e05252",
    dmNotes: "Hidden: neither the bandit nor the torch exists for players.",
  })
  b.light(G, "torch", [0.6, 0], 4.5, { attachedTokenId: bandit.id, name: "Bandit's torch" })
  b.token(G, [102.5, 67.5], {
    name: "Old Moss",
    label: "Barkeep",
    kind: "npc",
    size: "medium",
    speed: 30,
    color: "#b060e0",
  })

  return scene
}

// ---------------------------------------------------------------------------
// Stress test
// ---------------------------------------------------------------------------

/*
 * 60×60 cells (300 ft). Ground: 5×5 rooms of 60 ft with a door in every wall segment. Upper storey
 * over the north-west 2×2 rooms (stairs in room (1,0)), basement under the south-east 2×2 rooms
 * (ladder in room (3,3)). Exactly 20 shadow-casting lights and 15 tokens.
 */
function buildStressTest(): Scene {
  const scene = createScene({ name: "Stress Test", width: 60, depth: 60, groundFloor: false })
  const b = builder(scene)
  const rand = prng(0xa71a5)
  const ground = Object.values(scene.levels)[0]
  ground.name = "Ground"
  const basement = b.level({ name: "Basement", elevation: -10 })
  const upper = b.level({ name: "Upper", elevation: 10 })
  scene.environment = { ...defaultEnvironment(), skyLevel: "dark", ambientLevel: "dark" }
  scene.meta = { tags: ["sample", "benchmark"] }
  const ROOM = 60
  const presets: LightPreset[] = ["torch", "lantern", "brazier", "magical", "candle"]
  const doorStates: DoorState[] = ["open", "closed", "locked", "open"]
  const doorStyles: DoorStyle[] = ["wood", "iron", "wood", "bars", "portcullis", "secret"]
  const propKinds: PropKind[] = ["table", "crate", "barrel", "chest", "bookshelf", "bed", "altar", "statue", "rock", "chair"]
  const materials: MaterialId[] = ["stone", "brick", "wood", "plaster", "marble"]
  let doorCount = 0

  /** A room-grid storey: floor, boundary walls, one wall segment per room edge with a door (and every other one a window). */
  const storey = (levelId: Id, x0: number, z0: number, rooms: number, wallHeight: number) => {
    const extent = rooms * ROOM
    b.floor(levelId, rect(x0, z0, extent, extent), levelId === ground.id ? "stone" : "wood")
    b.walls(levelId, [[x0, z0], [x0 + extent, z0], [x0 + extent, z0 + extent], [x0, z0 + extent]], { height: wallHeight, material: "stone" }, true)
    for (let k = 1; k < rooms; k++) {
      for (let m = 0; m < rooms; m++) {
        const segs: [XZ, XZ][] = [
          [[x0 + k * ROOM, z0 + m * ROOM], [x0 + k * ROOM, z0 + (m + 1) * ROOM]],
          [[x0 + m * ROOM, z0 + k * ROOM], [x0 + (m + 1) * ROOM, z0 + k * ROOM]],
        ]
        for (const [a, c] of segs) {
          const w = b.wall(levelId, a, c, { height: wallHeight, material: materials[(k + m) % materials.length] })
          const n = doorCount++
          b.add(createDoor(w, ROOM / 2, { state: doorStates[n % doorStates.length], style: doorStyles[n % doorStyles.length] }))
          if (n % 2 === 0) b.add(createWindow(w, 12))
        }
      }
    }
  }
  /** Pillar and props of one room (kept clear of the room centre, where tokens stand). */
  const furnish = (levelId: Id, ox: number, oz: number, props: number) => {
    b.pillar(levelId, [ox + 47.5, oz + 12.5], { shape: rand() < 0.5 ? "round" : "square", size: 2, height: 8 })
    const spots: XZ[] = [
      [ox + 12.5, oz + 47.5],
      [ox + 47.5, oz + 47.5],
      [ox + 12.5, oz + 12.5],
    ]
    for (let k = 0; k < props; k++) {
      b.prop(levelId, propKinds[Math.floor(rand() * propKinds.length)], spots[k], { rotationY: Math.round(rand() * 8) * (Math.PI / 4) })
    }
  }

  // Ground: 5×5 rooms. Walls are 9 ft so they stop under the upper slab.
  storey(ground.id, 0, 0, 5, 9)
  for (let rb = 0; rb < 5; rb++) {
    for (let ra = 0; ra < 5; ra++) furnish(ground.id, ra * ROOM, rb * ROOM, (ra + rb) % 3 === 0 ? 3 : 2)
  }
  // Upper: north-west 2×2 rooms.
  storey(upper.id, 0, 0, 2, 9)
  for (let rb = 0; rb < 2; rb++) for (let ra = 0; ra < 2; ra++) furnish(upper.id, ra * ROOM, rb * ROOM, 2)
  // Basement: south-east 2×2 rooms.
  storey(basement.id, 180, 180, 2, 9)
  for (let rb = 0; rb < 2; rb++) for (let ra = 0; ra < 2; ra++) furnish(basement.id, 180 + ra * ROOM, 180 + rb * ROOM, 2)

  b.add(createConnector(ground.id, upper.id, rect(70, 20, 20, 10), 1, "stairs"))
  b.add(createConnector(basement.id, ground.id, rect(200, 200, 5, 5), 0, "ladder"))

  // 20 lights: 13 on the ground (rooms with an even a+b), 4 upstairs, 3 in the basement.
  let lightCount = 0
  const light = (levelId: Id, ox: number, oz: number) => {
    const preset = presets[lightCount++ % presets.length]
    b.light(levelId, preset, [ox + 20, oz + 40], undefined, { castsShadows: true, name: `Light ${lightCount}` })
  }
  for (let rb = 0; rb < 5; rb++) for (let ra = 0; ra < 5; ra++) if ((ra + rb) % 2 === 0) light(ground.id, ra * ROOM, rb * ROOM)
  for (let rb = 0; rb < 2; rb++) for (let ra = 0; ra < 2; ra++) light(upper.id, ra * ROOM, rb * ROOM)
  for (const [ra, rb] of [[0, 0], [1, 0], [1, 1]]) light(basement.id, 180 + ra * ROOM, 180 + rb * ROOM)

  // 15 tokens at room centres (odd footprints on a cell centre, even ones on a cell corner).
  const sizes: Token["size"][] = ["medium", "small", "medium", "large", "medium", "huge", "tiny", "medium", "small", "gargantuan"]
  let tokenCount = 0
  const token = (levelId: Id, ox: number, oz: number, size: Token["size"]) => {
    const even = size === "large" || size === "gargantuan"
    const at: XZ = even ? [ox + 30, oz + 30] : [ox + 32.5, oz + 32.5]
    const n = tokenCount++
    b.token(levelId, at, {
      name: `Token ${n + 1}`,
      label: `T${n + 1}`,
      kind: n % 3 === 0 ? "pc" : n % 3 === 1 ? "npc" : "monster",
      size,
      vision: { darkvision: n % 2 === 0 ? 60 : 0, blindsight: n === 7 ? 30 : 0, blind: n === 7 },
    })
  }
  const groundRooms = [0, 3, 6, 9, 12, 13, 16, 19, 22, 24]
  groundRooms.forEach((k, idx) => token(ground.id, (k % 5) * ROOM, Math.floor(k / 5) * ROOM, sizes[idx]))
  token(upper.id, 0, 0, "medium")
  token(upper.id, ROOM, ROOM, "medium")
  token(upper.id, 0, ROOM, "small")
  token(basement.id, 180, 180, "medium")
  token(basement.id, 240, 240, "large")

  return scene
}

// ---------------------------------------------------------------------------

export const SAMPLE_SCENES: SampleScene[] = [
  {
    id: "crooked-lantern",
    name: "The Crooked Lantern",
    description: "A moonlit roadside tavern over four levels: cellar, common room, bedrooms with a balcony, and roof.",
    build: buildCrookedLantern,
  },
  {
    id: "stress-test",
    name: "Stress Test",
    description: "3 levels, 20 shadow-casting lights, 15 tokens and ~150 walls, pillars and props on a 60×60 grid.",
    build: buildStressTest,
  },
  {
    id: "empty",
    name: "Empty Scene",
    description: "A single grassy ground level.",
    build: () => createScene(),
  },
]

export function sampleById(id: string): SampleScene | undefined {
  return SAMPLE_SCENES.find((s) => s.id === id)
}
