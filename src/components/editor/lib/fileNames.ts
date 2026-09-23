/**
 * Words of battlemap file names, shared by level naming (levelOps) and scene naming (importPlan):
 * "181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg" → Vineyard, Interiors, First, Floor.
 */

/** Publisher tags, grid markers and lighting variants that never name a map or a storey. */
export const FILE_NOISE_WORDS = "fa|nogrid|grid|gridless|day|night|dusk|dawn"

const NOISE_WORD = new RegExp(`^(${FILE_NOISE_WORDS})$`, "i")

/**
 * The words of a file name: extension dropped, split on separators and camelCase, without numbers
 * ("181"), grid sizes ("27x47") and words matching `drop` (default: FILE_NOISE_WORDS), which is
 * tested both before and after the camelCase split ("NoGrid", "FirstFloorNight").
 */
export function fileNameWords(fileName: string, drop: RegExp = NOISE_WORD): string[] {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "")
  return base
    .split(/[\s_\-.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^\d+x\d+$/i.test(w) && !drop.test(w))
    .flatMap((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
    .filter((w) => w && !drop.test(w))
}

/** Up to four words, first letter upper-cased; null when there are none. */
export function nameFromWords(words: readonly string[]): string | null {
  const text = words.slice(0, 4).join(" ").trim()
  return text ? text[0].toUpperCase() + text.slice(1) : null
}
