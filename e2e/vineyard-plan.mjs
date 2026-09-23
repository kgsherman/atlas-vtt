// Layout of the Forgotten Adventures "Vineyard" battlemaps (test_maps/, 27 × 47 cells of 5 ft) read off
// the art: house walls, doors and windows on the ground floor, the links between storeys, roofs, the
// lamps and fires the maps draw, and the party. World feet, x east / z south, origin at the map's
// top-left corner. The basement and second-floor outlines are traced from the images' alpha instead.
//
// Each house is described in its own rotated frame: `frame(origin, towards)` maps (u, v) feet along the
// house's first wall (origin → towards) and perpendicular to it to world (x, z).

const frame = (origin, towards, flip = false) => {
  const dx = towards[0] - origin[0]
  const dz = towards[1] - origin[1]
  const len = Math.hypot(dx, dz)
  const u = [dx / len, dz / len]
  const v = flip ? [u[1], -u[0]] : [-u[1], u[0]]
  const at = (U, V) => [
    round(origin[0] + U * u[0] + V * v[0]),
    round(origin[1] + U * u[1] + V * v[1]),
  ]
  return { at, length: len }
}
const round = (n) => Math.round(n * 100) / 100

/**
 * A wall run through (u, v) corners; openings are placed by their distance along the WHOLE run from its
 * first corner (resolved to the segment they fall on).
 */
const run = (
  f,
  corners,
  { closed = false, doors = [], windows = [], ...opts } = {}
) => ({
  points: [...corners, ...(closed ? [corners[0]] : [])].map(([U, V]) =>
    f.at(U, V)
  ),
  doors,
  windows,
  ...opts,
})

// ---- ground floor houses ---------------------------------------------------------------------------

// North-west house: an L (a 45 × 15 ft wing along the vineyard, rotated ~−52°, and a 15 × 27.5 ft arm
// towards the plaza) whose upper storey is the second-floor map. Origin = its west corner.
const nw = frame([5, 47.5], [33.5, 12.5])
// North-east house (storeroom + bedroom, rotated ~44°) above the cliff stair. Origin = its north corner.
const ne = frame([97.5, 33.5], [121.5, 57])
// South-west cottage (rotated ~29°) above the smugglers' cave. Origin = its north corner.
const sw = frame([16, 195.2], [31.9, 203.9])

export const GROUND_WALLS = [
  // NW house: exterior, starting at the west corner along the vineyard side.
  run(
    nw,
    [
      [0, 0],
      [45, 0],
      [45, 15],
      [15, 15],
      [15, 27.5],
      [0, 27.5],
    ],
    {
      closed: true,
      name: "Manor wall",
      material: "wood",
      // distance along the run: NW wall 0–45, NE end 45–60, patio side 60–90, arm 90–102.5, arm end 102.5–117.5, SW wall 117.5–145
      doors: [
        { at: 67, name: "Bedroom door (patio)" },
        { at: 83, name: "Hall door (patio)" },
        { at: 96, name: "Kitchen door (patio)" },
      ],
      windows: [{ at: 8 }, { at: 24 }, { at: 38 }, { at: 131 }],
    }
  ),
  // NW house interior: bedroom partition (with a door) and the kitchen screen wall.
  run(
    nw,
    [
      [31, 0],
      [31, 15],
    ],
    {
      name: "Bedroom partition",
      material: "plaster",
      height: 9,
      thickness: 0.5,
      doors: [{ at: 7.5, name: "Bedroom door" }],
    }
  ),
  run(
    nw,
    [
      [15, 0],
      [15, 7],
    ],
    { name: "Kitchen screen", material: "plaster", height: 9, thickness: 0.5 }
  ),
  // NE house: storeroom (NW part) + bedroom wing, as one outline; the porch sits in the inner corner.
  run(
    ne,
    [
      [0, 0],
      [33.6, 0],
      [33.6, 17],
      [12.6, 17],
      [12.6, 25.8],
      [0, 25.8],
    ],
    {
      closed: true,
      name: "Winery wall",
      material: "wood",
      // NE 0–33.6, SE 33.6–50.6, bedroom SW 50.6–71.6, porch 71.6–80.4, storeroom SW 80.4–93, NW 93–118.8
      doors: [
        { at: 44.6, name: "Deck door" },
        { at: 58, name: "Porch door" },
        { at: 86.7, name: "Plaza door" },
      ],
      windows: [{ at: 8 }, { at: 25 }, { at: 106 }],
    }
  ),
  run(
    ne,
    [
      [14.5, 0],
      [14.5, 17],
    ],
    {
      name: "Winery partition",
      material: "plaster",
      height: 9,
      thickness: 0.5,
      doors: [{ at: 8.5, name: "Bedroom door" }],
    }
  ),
  // SW cottage.
  run(
    sw,
    [
      [0, 0],
      [18.1, 0],
      [18.1, 14.2],
      [0, 14.2],
    ],
    {
      closed: true,
      name: "Cottage wall",
      material: "wood",
      // NE 0–18.1, SE 18.1–32.3, SW 32.3–50.4, NW 50.4–64.6
      doors: [{ at: 37.5, name: "Cottage door" }],
      windows: [{ at: 10 }, { at: 58 }],
    }
  ),
]

/** Roof slabs on the second-floor level over the houses that have no upper storey (world polygons). */
export const ROOFS = [
  {
    name: "Winery roof",
    polygon: [
      ne.at(-0.6, -0.6),
      ne.at(34.2, -0.6),
      ne.at(34.2, 17.6),
      ne.at(13.2, 17.6),
      ne.at(13.2, 26.4),
      ne.at(-0.6, 26.4),
    ],
  },
  {
    name: "Cottage roof",
    polygon: [
      sw.at(-0.6, -0.6),
      sw.at(18.7, -0.6),
      sw.at(18.7, 14.8),
      sw.at(-0.6, 14.8),
    ],
  },
  // The manor's patio-side loggia between the upper storey's wings stays open to the sky.
]

// ---- links between storeys -----------------------------------------------------------------------------

/** Cell-aligned connector footprints (levels by role: "basement" | "ground" | "upper"). */
export const CONNECTORS = [
  // Manor stairs: on the drawn staircase against the hall's north-west wall (connectors are grid-aligned,
  // the art is rotated), climbing south (+Z) to the upper corridor, where the stairwell leaves room to walk
  // around it to both ends of the storey.
  {
    name: "Manor stairs",
    from: "ground",
    to: "upper",
    style: "stairs",
    rect: { x: 20, z: 30, w: 5, d: 10 },
    direction: 0,
  },
  // Trapdoor in the winery's back room down to the smugglers' shelf of the sea cave.
  {
    name: "Winery trapdoor",
    from: "basement",
    to: "ground",
    style: "ladder",
    rect: { x: 105, z: 55, w: 5, d: 5 },
    direction: 0,
  },
  // Trapdoor in the cottage down to the cave at the end of the cliff tunnel.
  {
    name: "Cottage trapdoor",
    from: "basement",
    to: "ground",
    style: "ladder",
    rect: { x: 20, z: 200, w: 5, d: 5 },
    direction: 0,
  },
]

// ---- lights ----------------------------------------------------------------------------------------------

/** [preset, x, z, overrides] per level role, at the lamps, candles and fires the maps draw. */
export const LIGHTS = {
  ground: [
    ["lantern", 31.5, 18, { name: "Bedroom lamp" }],
    [
      "candle",
      22,
      42.5,
      { name: "Hall candles", dimRadius: 15, brightRadius: 7 },
    ],
    ["brazier", 10.5, 48.5, { name: "Kitchen hearth" }],
    ["lantern", 25, 52, { name: "Dining lamp" }],
    ["lantern", 93, 43, { name: "Storeroom lamp" }],
    [
      "candle",
      110,
      53.5,
      { name: "Winemaker's candle", dimRadius: 15, brightRadius: 7 },
    ],
    ["torch", 91.5, 62, { name: "Porch lantern" }],
    ["brazier", 20.5, 197, { name: "Cottage stove" }],
  ],
  basement: [
    ["torch", 20, 52.5, { name: "Cave torch (west)" }],
    ["torch", 18.5, 82.5, { name: "Cave torch (tunnel mouth)" }],
    ["brazier", 100, 31.5, { name: "Smugglers' fire" }],
    ["torch", 43.5, 131, { name: "Middle cave torch" }],
    ["torch", 21.5, 192.5, { name: "Lower cave torch" }],
    [
      "candle",
      35,
      193.5,
      { name: "Lower cave candle", dimRadius: 15, brightRadius: 7 },
    ],
  ],
  upper: [
    [
      "candle",
      37,
      17,
      { name: "Upstairs candle", dimRadius: 20, brightRadius: 10 },
    ],
    ["lantern", 20, 52.5, { name: "Upstairs lantern" }],
    [
      "candle",
      8,
      46.5,
      { name: "Bedside candle", dimRadius: 15, brightRadius: 7 },
    ],
  ],
}

// ---- party & monsters ---------------------------------------------------------------------------------------

export const TOKENS = [
  {
    role: "ground",
    name: "Wren Underbough",
    label: "Wren",
    kind: "pc",
    size: "small",
    height: 3,
    eyeHeight: 2.6,
    speed: 25,
    color: "#4ade80",
    at: [62.5, 77.5],
    vision: { darkvision: 60, blindsight: 0, blind: false },
    dmNotes: "Halfling rogue with darkvision.",
  },
  {
    role: "ground",
    name: "Aldric Vane",
    label: "Aldric",
    kind: "pc",
    size: "medium",
    speed: 30,
    color: "#60a5fa",
    at: [72.5, 72.5],
    vision: { darkvision: 0, blindsight: 0, blind: false },
    dmNotes: "Human fighter: no darkvision.",
  },
  {
    role: "ground",
    name: "Brunhild Ironvein",
    label: "Brunhild",
    kind: "pc",
    size: "medium",
    height: 4.5,
    eyeHeight: 4,
    speed: 25,
    color: "#f59e0b",
    at: [72.5, 82.5],
    vision: { darkvision: 60, blindsight: 0, blind: false },
    dmNotes: "Dwarf cleric with darkvision.",
  },
  {
    role: "basement",
    name: "Cave Troll",
    label: "Troll",
    kind: "monster",
    size: "large",
    speed: 30,
    color: "#b91c1c",
    at: [55, 140],
    hidden: true,
    vision: { darkvision: 60, blindsight: 0, blind: false },
    dmNotes: "Hidden until the party reaches the middle cave.",
  },
]
