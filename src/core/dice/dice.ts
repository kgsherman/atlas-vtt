/**
 * Dice notation (docs/ARCHITECTURE.md §6.5): parse "2d20kh1 + 5 to hit", roll it, describe the result.
 *
 * Grammar (case-insensitive, spaces allowed around operators):
 *   formula := [+|-] term ((+|-) term)*        then the rest of the input is the roll's label
 *   term    := dice | integer | "adv" | "dis"
 *   dice    := [count] "d" (sides | "%") ["!"] [("kh"|"kl"|"dh"|"dl"|"k") [n]]
 * "adv" / "dis" are 2d20kh1 / 2d20kl1, "d%" is d100, "!" explodes (a die showing its maximum adds another
 * die, at most DICE_LIMITS.maxExplosions per roll), "k" is "kh". Keep / drop count defaults to 1.
 *
 * Rolls are made by whoever is authoritative (the host), with an injected RNG (`cryptoDiceRng` in
 * production: unbiased, from crypto.getRandomValues), so players cannot pick their own results.
 */

export const DICE_LIMITS = {
  /** Characters of the formula part of an input (the label is separate). */
  maxFormulaLength: 100,
  maxLabelLength: 80,
  maxTerms: 12,
  /** Dice rolled by one formula before explosions. */
  maxDice: 100,
  maxSides: 1000,
  maxConstant: 10_000,
  /** Extra dice from exploding, per roll. */
  maxExplosions: 50,
} as const

export type KeepMode = "kh" | "kl" | "dh" | "dl"

export type DiceTerm =
  | { kind: "dice"; sign: 1 | -1; count: number; sides: number; explode: boolean; keep: { mode: KeepMode; n: number } | null }
  | { kind: "const"; sign: 1 | -1; value: number }

export interface DiceFormula {
  terms: DiceTerm[]
  /** Canonical text, e.g. "2d20kh1 + 5". */
  text: string
}

export type ParseRollResult = { ok: true; formula: DiceFormula; label: string } | { ok: false; error: string }

/** One rolled term. `rolls` in rolling order; `dropped`: indices into `rolls` not counted. */
export type RolledTerm =
  | { kind: "dice"; sign: 1 | -1; count: number; sides: number; explode: boolean; keep: { mode: KeepMode; n: number } | null; rolls: number[]; dropped: number[] }
  | { kind: "const"; sign: 1 | -1; value: number }

export interface RollResult {
  /** Canonical formula text. */
  formula: string
  total: number
  terms: RolledTerm[]
}

/** Uniform integer in 1..sides. */
export type DiceRng = (sides: number) => number

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DICE_RE = /^(\d*)d(\d+|%)(!?)(?:(kh|kl|dh|dl|k)(\d*))?/i
const INT_RE = /^\d+/
const ALIAS_RE = /^(adv|dis)(?![a-z0-9])/i

function termText(t: DiceTerm): string {
  if (t.kind === "const") return String(t.value)
  const keep = t.keep ? `${t.keep.mode}${t.keep.n}` : ""
  return `${t.count}d${t.sides}${t.explode ? "!" : ""}${keep}`
}

export function formulaText(terms: readonly DiceTerm[]): string {
  let out = ""
  terms.forEach((t, k) => {
    if (k === 0) out = t.sign < 0 ? `-${termText(t)}` : termText(t)
    else out += `${t.sign < 0 ? " - " : " + "}${termText(t)}`
  })
  return out
}

/** Printable text without control characters, whitespace collapsed, at most `max` characters. */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()
  return [...flat].slice(0, max).join("")
}

/**
 * Parse "formula [label]". The formula ends where the input stops continuing it ("1d20+5 to hit": label
 * "to hit"); a leading "#" or ":" of the label is dropped. Errors name the first problem in plain words.
 */
export function parseRoll(input: string): ParseRollResult {
  if (typeof input !== "string") return { ok: false, error: "Type a dice formula, like 1d20+5." }
  const src = input.replace(/^\s+/, "")
  if (src.length === 0) return { ok: false, error: "Type a dice formula, like 1d20+5." }
  const terms: DiceTerm[] = []
  let pos = 0
  let dice = 0
  let formulaEnd = 0
  const skipSpaces = () => {
    while (pos < src.length && src[pos] === " ") pos++
  }
  for (;;) {
    // Operator (optional before the first term).
    skipSpaces()
    let sign: 1 | -1 = 1
    const hadTerms = terms.length > 0
    if (src[pos] === "+" || src[pos] === "-") {
      sign = src[pos] === "-" ? -1 : 1
      pos++
      skipSpaces()
    } else if (hadTerms) {
      break
    }
    const rest = src.slice(pos)
    let term: DiceTerm | null = null
    let m: RegExpExecArray | null
    if ((m = ALIAS_RE.exec(rest))) {
      term = { kind: "dice", sign, count: 2, sides: 20, explode: false, keep: { mode: m[1].toLowerCase() === "adv" ? "kh" : "kl", n: 1 } }
      pos += m[0].length
    } else if ((m = DICE_RE.exec(rest))) {
      const count = m[1] === "" ? 1 : Number(m[1])
      const sides = m[2] === "%" ? 100 : Number(m[2])
      const explode = m[3] === "!"
      if (count < 1) return { ok: false, error: "Roll at least one die." }
      if (!Number.isSafeInteger(count) || count > DICE_LIMITS.maxDice) return { ok: false, error: `At most ${DICE_LIMITS.maxDice} dice per roll.` }
      if (!Number.isSafeInteger(sides) || sides < 1 || sides > DICE_LIMITS.maxSides) return { ok: false, error: `Dice have 1 to ${DICE_LIMITS.maxSides} sides.` }
      if (explode && sides < 2) return { ok: false, error: "Only dice with 2 or more sides can explode." }
      let keep: { mode: KeepMode; n: number } | null = null
      if (m[4]) {
        const mode = (m[4].toLowerCase() === "k" ? "kh" : m[4].toLowerCase()) as KeepMode
        const n = m[5] === "" ? 1 : Number(m[5])
        if (!Number.isSafeInteger(n) || n < 1 || n > count) return { ok: false, error: `Keep or drop 1 to ${count} of ${count}d${sides}.` }
        keep = { mode, n }
      }
      dice += count
      if (dice > DICE_LIMITS.maxDice) return { ok: false, error: `At most ${DICE_LIMITS.maxDice} dice per roll.` }
      term = { kind: "dice", sign, count, sides, explode, keep }
      pos += m[0].length
    } else if ((m = INT_RE.exec(rest))) {
      const value = Number(m[0])
      if (!Number.isSafeInteger(value) || value > DICE_LIMITS.maxConstant) return { ok: false, error: `Numbers go up to ${DICE_LIMITS.maxConstant}.` }
      term = { kind: "const", sign, value }
      pos += m[0].length
    }
    if (!term) {
      if (!hadTerms) return { ok: false, error: "Start with dice or a number, like 1d20+5." }
      return { ok: false, error: `Expected dice or a number after "${sign < 0 ? "-" : "+"}".` }
    }
    // A term must end at a word boundary ("2d6fire" is not "2d6" + "fire").
    if (pos < src.length && /[a-z0-9!%]/i.test(src[pos])) return { ok: false, error: `Can't read "${src.slice(0, pos + 1).trim()}…".` }
    terms.push(term)
    if (terms.length > DICE_LIMITS.maxTerms) return { ok: false, error: `At most ${DICE_LIMITS.maxTerms} terms per roll.` }
    formulaEnd = pos
  }
  if (formulaEnd > DICE_LIMITS.maxFormulaLength) return { ok: false, error: "That formula is too long." }
  const label = cleanText(src.slice(formulaEnd).replace(/^\s*[#:]?/, ""), DICE_LIMITS.maxLabelLength)
  return { ok: true, formula: { terms, text: formulaText(terms) }, label }
}

/** Whether the whole input is a formula (no label left over), e.g. to tell "/r d20" from chat. */
export function isFormula(input: string): boolean {
  const r = parseRoll(input)
  return r.ok && r.label === ""
}

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

/** Indices of the dice a keep / drop rule removes (lowest index first among equal values). */
function droppedIndices(rolls: readonly number[], keep: { mode: KeepMode; n: number } | null): number[] {
  if (!keep) return []
  const order = rolls.map((v, k) => ({ v, k }))
  // Ascending by value, ties by index: the dice a rule drops are then a prefix or a suffix.
  order.sort((a, b) => a.v - b.v || a.k - b.k)
  const n = rolls.length
  let drop: { v: number; k: number }[]
  switch (keep.mode) {
    case "kh":
      drop = order.slice(0, Math.max(0, n - keep.n))
      break
    case "kl":
      drop = order.slice(Math.min(n, keep.n))
      break
    case "dh":
      drop = order.slice(Math.max(0, n - keep.n))
      break
    case "dl":
      drop = order.slice(0, Math.min(n, keep.n))
      break
  }
  return drop.map((d) => d.k).sort((a, b) => a - b)
}

/** Roll a parsed formula. `rng` must return integers in 1..sides. */
export function rollFormula(formula: DiceFormula, rng: DiceRng): RollResult {
  let explosions = 0
  let total = 0
  const terms: RolledTerm[] = formula.terms.map((t): RolledTerm => {
    if (t.kind === "const") {
      total += t.sign * t.value
      return { kind: "const", sign: t.sign, value: t.value }
    }
    const rolls: number[] = []
    for (let k = 0; k < t.count; k++) {
      let v = rng(t.sides)
      rolls.push(v)
      while (t.explode && v === t.sides && explosions < DICE_LIMITS.maxExplosions) {
        explosions++
        v = rng(t.sides)
        rolls.push(v)
      }
    }
    const dropped = droppedIndices(rolls, t.keep)
    const skip = new Set(dropped)
    let sum = 0
    rolls.forEach((v, k) => {
      if (!skip.has(k)) sum += v
    })
    total += t.sign * sum
    return { kind: "dice", sign: t.sign, count: t.count, sides: t.sides, explode: t.explode, keep: t.keep ? { ...t.keep } : null, rolls, dropped }
  })
  return { formula: formula.text, total, terms }
}

/** Unbiased dice from crypto.getRandomValues (rejection sampling). */
export function cryptoDiceRng(): DiceRng {
  const buf = new Uint32Array(1)
  return (sides) => {
    const limit = Math.floor(0x1_0000_0000 / sides) * sides
    for (;;) {
      globalThis.crypto.getRandomValues(buf)
      if (buf[0] < limit) return (buf[0] % sides) + 1
    }
  }
}

/** Parse and roll in one go. */
export function roll(input: string, rng: DiceRng): { ok: true; result: RollResult; label: string } | { ok: false; error: string } {
  const p = parseRoll(input)
  if (!p.ok) return p
  return { ok: true, result: rollFormula(p.formula, rng), label: p.label }
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

/**
 * The natural d20 of a roll: when its only dice term is d20s keeping exactly one die (1d20, adv, dis),
 * the value of that kept die, else null. For "natural 20" / "natural 1" highlights.
 */
export function naturalD20(r: RollResult): number | null {
  const dice = r.terms.filter((t) => t.kind === "dice")
  if (dice.length !== 1) return null
  const t = dice[0]
  if (t.kind !== "dice" || t.sides !== 20 || t.explode || t.sign < 0) return null
  const kept = t.rolls.filter((_, k) => !t.dropped.includes(k))
  return kept.length === 1 ? kept[0] : null
}

/** Plain-text summary, e.g. "2d20kh1 + 5: [17, (4)] + 5 = 22" (dropped dice in parentheses). */
export function describeRoll(r: RollResult): string {
  const parts = r.terms.map((t, k) => {
    const op = k === 0 ? (t.sign < 0 ? "-" : "") : t.sign < 0 ? " - " : " + "
    if (t.kind === "const") return `${op}${t.value}`
    const dice = t.rolls.map((v, i) => (t.dropped.includes(i) ? `(${v})` : String(v))).join(", ")
    return `${op}[${dice}]`
  })
  return `${r.formula}: ${parts.join("")} = ${r.total}`
}
