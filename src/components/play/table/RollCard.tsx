/**
 * A dice roll in the chat log: the formula, every die (dropped ones struck through), and the total,
 * with natural 20s and 1s called out on single-d20 rolls. Clicking the formula rolls it again.
 */
import { Button } from "@/components/ui/button"
import { naturalD20, type RollResult } from "@/core/dice/dice"
import { cn } from "@/lib/utils"

export function RollCard({
  roll,
  onReroll,
}: {
  roll: RollResult
  onReroll?: (formula: string) => void
}) {
  const nat = naturalD20(roll)
  const crit = nat === 20
  const fumble = nat === 1
  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-2 rounded-md border bg-background/40 px-2 py-1.5",
        crit && "border-sidebar-primary/60",
        fumble && "border-destructive/60"
      )}
      data-slot="roll-card"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {onReroll ? (
          <Button
            variant="link"
            size="xs"
            className="h-auto w-fit justify-start truncate p-0 text-[0.6875rem] font-normal text-muted-foreground hover:text-foreground"
            title="Roll again"
            onClick={() => onReroll(roll.formula)}
          >
            {roll.formula}
          </Button>
        ) : (
          <span className="truncate text-[0.6875rem] text-muted-foreground">
            {roll.formula}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1 text-[0.6875rem] tabular-nums">
          {roll.terms.map((t, k) => (
            <span key={k} className="flex items-center gap-1">
              {k > 0 || t.sign < 0 ? (
                <span className="text-muted-foreground">
                  {t.sign < 0 ? "−" : "+"}
                </span>
              ) : null}
              {t.kind === "const" ? (
                <span className="font-medium">{t.value}</span>
              ) : (
                t.rolls.map((v, i) => {
                  const dropped = t.dropped.includes(i)
                  return (
                    <span
                      key={i}
                      title={`d${t.sides}${dropped ? " (dropped)" : ""}`}
                      className={cn(
                        "inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-medium",
                        dropped && "line-through opacity-40",
                        !dropped && v === t.sides && "text-sidebar-primary",
                        !dropped && v === 1 && t.sides > 1 && "text-destructive"
                      )}
                    >
                      {v}
                    </span>
                  )
                })
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span
          className={cn(
            "font-heading text-xl leading-none font-semibold tabular-nums",
            crit && "text-sidebar-primary",
            fumble && "text-destructive"
          )}
          data-slot="roll-total"
        >
          {roll.total}
        </span>
        {crit || fumble ? (
          <span
            className={cn(
              "mt-0.5 text-[0.625rem] font-medium tracking-wide uppercase",
              crit ? "text-sidebar-primary" : "text-destructive"
            )}
          >
            {crit ? "Natural 20" : "Natural 1"}
          </span>
        ) : null}
      </div>
    </div>
  )
}
