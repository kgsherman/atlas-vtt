/**
 * Scene → visual mesh descriptions per level and bucket (ARCHITECTURE §4.3). The engine owns the
 * three.js objects and materials; see ./types for the output format.
 */
import type { Id } from "@/core/scene/types"

import { buildConnectorsBucket } from "./connectors"
import type { BuildContext } from "./context"
import { buildDoorsBucket } from "./doors"
import { buildFixturesBucket } from "./fixtures"
import { buildFloorsBucket } from "./floors"
import { buildPillarsBucket, buildPropsBucket } from "./props"
import { BUCKETS, type BucketBuild, type BucketKind } from "./types"
import { buildWallsBucket } from "./walls"

export { BuildContext, type BuildScene } from "./context"
export * from "./types"

export function buildBucket(ctx: BuildContext, levelId: Id, kind: BucketKind): BucketBuild {
  switch (kind) {
    case "floors":
      return buildFloorsBucket(ctx, levelId)
    case "walls":
      return buildWallsBucket(ctx, levelId)
    case "doors":
      return buildDoorsBucket(ctx, levelId)
    case "connectors":
      return buildConnectorsBucket(ctx, levelId)
    case "pillars":
      return buildPillarsBucket(ctx, levelId)
    case "props":
      return buildPropsBucket(ctx, levelId)
    case "fixtures":
      return buildFixturesBucket(ctx, levelId)
  }
}

/** Every bucket of a level. */
export function buildLevel(ctx: BuildContext, levelId: Id): Record<BucketKind, BucketBuild> {
  const out = {} as Record<BucketKind, BucketBuild>
  for (const kind of BUCKETS) out[kind] = buildBucket(ctx, levelId, kind)
  return out
}
