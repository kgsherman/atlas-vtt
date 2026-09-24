/**
 * Public API of core/tokenMaker (ARCHITECTURE §11): token designs (layers, transforms, masks), their
 * validation, and frame opening detection. Rendering lives in src/tokenMaker (Canvas 2D).
 */
export type * from "./types"
export { TOKEN_DESIGN_VERSION } from "./types"
export * from "./design"
export { detectFrameOpening, type FrameOpeningOptions } from "./frame"
export { designImageIds, parseTokenDesign, tokenDesignSchema } from "./schema"
