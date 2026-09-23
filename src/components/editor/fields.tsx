/**
 * Compact form controls for the editor panels, composed from shadcn primitives. Text and number
 * inputs keep a local draft and commit on Enter / blur (Escape reverts), so each edit is one undo step.
 */
import * as React from "react"

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { trimNumber } from "./lib/format"

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-2 border-b border-border/60 px-3 py-3 last:border-b-0", className)}>
      {title || action ? (
        <div className="flex min-h-6 items-center justify-between gap-2">
          {title ? <h3 className="text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3> : <span />}
          {action ? <div className="flex items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/**
 * Id of the enclosing FieldRow's label: the controls below name themselves after it (aria-labelledby),
 * so screen readers announce "Elevation" rather than an unnamed textbox. No call site has to wire it.
 */
const FieldLabelContext = React.createContext<string | undefined>(undefined)

/** aria-labelledby for a control: the row label, unless the control has its own aria-label (which wins). */
function useLabelledBy(ariaLabel?: string): string | undefined {
  const id = React.useContext(FieldLabelContext)
  return ariaLabel ? undefined : id
}

/** Label on the left, control on the right. */
export function FieldRow({ label, htmlFor, hint, children, className }: { label: React.ReactNode; htmlFor?: string; hint?: string; children: React.ReactNode; className?: string }) {
  const labelId = React.useId()
  const labelEl = (
    <Label id={labelId} htmlFor={htmlFor} className="min-w-0 truncate text-xs font-normal text-muted-foreground">
      {label}
    </Label>
  )
  return (
    <div className={cn("grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2", className)}>
      {hint ? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 cursor-help" />}>{labelEl}</TooltipTrigger>
          <TooltipContent side="left">{hint}</TooltipContent>
        </Tooltip>
      ) : (
        labelEl
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
      </div>
    </div>
  )
}

/** Two controls side by side (e.g. X and Z). */
export function FieldPair({ children }: { children: React.ReactNode }) {
  return <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">{children}</div>
}

export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-[0.6875rem] leading-snug text-muted-foreground", className)}>{children}</p>
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function useDraft<T>(value: T, format: (v: T) => string) {
  const [draft, setDraft] = React.useState<string | null>(null)
  return { text: draft ?? format(value), draft, setDraft }
}

export interface NumberInputProps {
  value: number | null
  onCommit(value: number): void
  min?: number
  max?: number
  step?: number
  /** Decimals shown. */
  precision?: number
  unit?: string
  prefix?: React.ReactNode
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
  "aria-label"?: string
}

/** Numeric field: Enter/blur commits, Escape reverts, ↑/↓ step (Shift ×10). Values are clamped. */
export function NumberInput({ value, onCommit, min, max, step = 1, precision = 2, unit, prefix, placeholder, disabled, className, id, ...rest }: NumberInputProps) {
  const format = (v: number | null) => (v === null ? "" : trimNumber(v, precision))
  const { text, draft, setDraft } = useDraft(value, format)
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const labelledBy = useLabelledBy(rest["aria-label"])

  const commit = (raw: string) => {
    setDraft(null)
    const trimmed = raw.trim().replace(",", ".")
    if (trimmed === "") return
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return
    const next = clamp(n)
    if (value === null || Math.abs(next - value) > 1e-9) onCommit(next)
  }

  return (
    <InputGroup className={cn("h-7 min-w-0", className)} data-disabled={disabled || undefined}>
      {prefix ? <InputGroupAddon className="pr-0 text-[0.625rem] uppercase">{prefix}</InputGroupAddon> : null}
      <InputGroupInput
        id={id}
        aria-label={rest["aria-label"]}
        aria-labelledby={labelledBy}
        inputMode="decimal"
        className="h-full px-2 text-xs tabular-nums"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value)
            e.currentTarget.blur()
          } else if (e.key === "Escape") {
            setDraft(null)
            e.currentTarget.blur()
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault()
            const base = Number((draft ?? format(value)).replace(",", "."))
            const current = Number.isFinite(base) ? base : (value ?? 0)
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            const next = clamp(Math.round((current + delta) / step) * step)
            setDraft(null)
            onCommit(Number(next.toFixed(6)))
          }
        }}
      />
      {unit ? <InputGroupAddon align="inline-end" className="text-[0.625rem]">{unit}</InputGroupAddon> : null}
    </InputGroup>
  )
}

export function TextInput({
  value,
  onCommit,
  placeholder,
  maxLength = 200,
  className,
  id,
  disabled,
  autoFocus,
  "aria-label": ariaLabel,
}: {
  value: string
  onCommit(value: string): void
  placeholder?: string
  maxLength?: number
  className?: string
  id?: string
  disabled?: boolean
  autoFocus?: boolean
  "aria-label"?: string
}) {
  const { text, draft, setDraft } = useDraft(value, (v) => v)
  const labelledBy = useLabelledBy(ariaLabel)
  const commit = (raw: string) => {
    setDraft(null)
    if (raw !== value) onCommit(raw)
  }
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      className={cn("h-7 text-xs", className)}
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit(e.currentTarget.value)
          e.currentTarget.blur()
        } else if (e.key === "Escape") {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function NotesInput({ value, onCommit, placeholder }: { value: string; onCommit(value: string): void; placeholder?: string }) {
  const { text, draft, setDraft } = useDraft(value, (v) => v)
  return (
    <Textarea
      className="min-h-16 resize-y text-xs"
      value={text}
      placeholder={placeholder}
      maxLength={2000}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

const HEX_RE = /^#[0-9a-f]{6}$/i

/** Swatch (native colour picker) + hex text. */
export function ColorInput({
  value,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange(value: string): void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  const { text, setDraft } = useDraft(value, (v) => v)
  const labelledBy = useLabelledBy(ariaLabel)
  const swatchId = React.useId()
  const commit = (raw: string) => {
    setDraft(null)
    const v = raw.startsWith("#") ? raw : `#${raw}`
    if (HEX_RE.test(v) && v.toLowerCase() !== value.toLowerCase()) onChange(v.toLowerCase())
  }
  return (
    <InputGroup className={cn("h-7 min-w-0", className)} data-disabled={disabled || undefined}>
      <InputGroupAddon className="pr-0 pl-1">
        <label className="relative block size-5 cursor-pointer overflow-hidden rounded-sm border border-border shadow-inner" style={{ backgroundColor: value }}>
          <span id={swatchId} className="sr-only">
            Pick colour
          </span>
          <input
            type="color"
            aria-label={ariaLabel ? `${ariaLabel}: pick colour` : undefined}
            aria-labelledby={labelledBy ? `${labelledBy} ${swatchId}` : undefined}
            className="absolute inset-0 cursor-pointer opacity-0"
            value={HEX_RE.test(value) ? value : "#000000"}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
          />
        </label>
      </InputGroupAddon>
      <InputGroupInput
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        className="h-full px-2 font-mono text-[0.6875rem] uppercase"
        value={text}
        disabled={disabled}
        maxLength={7}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape") {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    </InputGroup>
  )
}

/** Slider with its value printed on the right. */
export function SliderInput({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  format = (v) => trimNumber(v, 2),
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number
  onChange(value: number): void
  onCommit?(value: number): void
  min: number
  max: number
  step: number
  format?: (v: number) => string
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  const rowLabel = useLabelledBy(ariaLabel)
  // Base UI's Slider.Root forwards aria-labelledby (not aria-label) to the thumb's range input.
  const ownLabelId = React.useId()
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      {ariaLabel ? (
        <span id={ownLabelId} className="sr-only">
          {ariaLabel}
        </span>
      ) : null}
      <Slider
        aria-labelledby={ariaLabel ? ownLabelId : rowLabel}
        className="min-w-0 flex-1"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(Array.isArray(v) ? (v as number[])[0] : (v as number))}
        onValueCommitted={(v) => onCommit?.(Array.isArray(v) ? (v as number[])[0] : (v as number))}
      />
      <span className="w-10 shrink-0 text-right text-[0.6875rem] text-muted-foreground tabular-nums">{format(value)}</span>
    </div>
  )
}

export function SwitchField({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  checked: boolean
  onCheckedChange(checked: boolean): void
  disabled?: boolean
  id?: string
}) {
  const autoId = React.useId()
  const switchId = id ?? autoId
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={switchId} className="text-xs font-normal">
          {label}
        </Label>
        {description ? <span className="text-[0.6875rem] leading-snug text-muted-foreground">{description}</span> : null}
      </div>
      <Switch id={switchId} size="sm" className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={(c) => onCheckedChange(c)} />
    </div>
  )
}

export interface Option<V extends string> {
  value: V
  label: React.ReactNode
  icon?: React.ReactNode
  tooltip?: React.ReactNode
  /** Accessible name when the label is not plain text (icon-only options); default: the label or a text tooltip. */
  ariaLabel?: string
  disabled?: boolean
}

/** Single-choice segmented control (ToggleGroup). */
export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "sm",
  disabled,
  "aria-label": ariaLabel,
}: {
  value: V
  onValueChange(value: V): void
  options: readonly Option<V>[]
  className?: string
  size?: "sm" | "default"
  disabled?: boolean
  "aria-label"?: string
}) {
  const labelledBy = useLabelledBy(ariaLabel)
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      variant="outline"
      size={size}
      spacing={0}
      className={cn("min-w-0", className)}
      value={[value]}
      disabled={disabled}
      onValueChange={(v) => {
        const next = v[0]
        if (next !== undefined && next !== value) onValueChange(next as V)
      }}
    >
      {options.map((o) => {
        const item = (
          <ToggleGroupItem
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            aria-label={o.ariaLabel ?? (typeof o.label === "string" ? o.label : typeof o.tooltip === "string" ? o.tooltip : undefined)}
            className="grow gap-1 px-2 text-[0.6875rem]"
          >
            {o.icon}
            {o.label}
          </ToggleGroupItem>
        )
        if (!o.tooltip) return item
        return (
          <Tooltip key={o.value}>
            <TooltipTrigger render={item} />
            <TooltipContent>{o.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </ToggleGroup>
  )
}

/** Dropdown select over a fixed option list (the trigger shows the chosen option's icon + label). */
export function SelectInput<V extends string>({
  value,
  onValueChange,
  options,
  className,
  disabled,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: V | null
  onValueChange(value: V): void
  options: readonly Option<V>[]
  className?: string
  disabled?: boolean
  placeholder?: string
  "aria-label"?: string
}) {
  const current = options.find((o) => o.value === value)
  const labelledBy = useLabelledBy(ariaLabel)
  return (
    <Select<V> value={value} disabled={disabled} onValueChange={(v) => v !== null && onValueChange(v as V)}>
      <SelectTrigger size="sm" aria-label={ariaLabel} aria-labelledby={labelledBy} className={cn("h-7 w-full min-w-0 text-xs", className)}>
        <SelectValue placeholder={placeholder}>
          {() =>
            current ? (
              <>
                {current.icon}
                <span className="truncate">{current.label}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{placeholder ?? ""}</span>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} className="text-xs">
            {o.icon}
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
