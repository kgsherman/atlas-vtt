/** Icons, labels and colours of token health and conditions (shared by the health UI and map badges). */
import {
  ArrowDownToLine,
  BatteryLow,
  Brain,
  CircleSlash,
  EarOff,
  EyeOff,
  Heart,
  FlaskConical,
  Frown,
  Ghost,
  Grab,
  Link,
  Moon,
  Mountain,
  Skull,
  Sparkles,
  ZapOff,
  type LucideIcon,
} from "lucide-react"

import type { HealthBand, TokenCondition } from "@/core/scene/tokenStatus"

export const CONDITION_ICONS: Readonly<Record<TokenCondition, LucideIcon>> = {
  blinded: EyeOff,
  charmed: Heart,
  deafened: EarOff,
  frightened: Frown,
  grappled: Grab,
  incapacitated: CircleSlash,
  invisible: Ghost,
  paralyzed: ZapOff,
  petrified: Mountain,
  poisoned: FlaskConical,
  prone: ArrowDownToLine,
  restrained: Link,
  stunned: Sparkles,
  unconscious: Moon,
  exhaustion: BatteryLow,
  concentrating: Brain,
  dead: Skull,
}

export const BAND_LABELS: Readonly<Record<HealthBand, string>> = {
  unhurt: "Unhurt",
  wounded: "Wounded",
  bloodied: "Bloodied",
  down: "Down",
}

/** Bar colour of a band (theme tokens). */
export function bandClass(band: HealthBand): string {
  switch (band) {
    case "unhurt":
      return "bg-sidebar-primary"
    case "wounded":
      return "bg-warning"
    case "bloodied":
      return "bg-destructive"
    case "down":
      return "bg-muted-foreground"
  }
}
