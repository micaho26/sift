/**
 * UI primitives.
 *
 * Deliberately hand-written rather than pulled from a component library: the whole
 * set is ~250 lines, it carries no dependency risk, and every visual decision
 * lands in the design tokens instead of fighting someone else's defaults.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { scoreBand } from '@sift/core'
import { X } from 'lucide-react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ button -- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
  size?: 'xs' | 'sm' | 'md'
  icon?: ReactNode
  trailing?: ReactNode
}

const BUTTON_VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 border border-transparent shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.16)]',
  secondary: 'bg-bg-elevated text-fg border border-border hover:bg-bg-hover active:bg-bg-active',
  ghost: 'bg-transparent text-fg-secondary hover:bg-bg-hover hover:text-fg border border-transparent',
  subtle: 'bg-bg-subtle text-fg-secondary hover:bg-bg-hover hover:text-fg border border-border-subtle',
  danger: 'bg-transparent text-danger hover:bg-danger-muted border border-transparent',
}

const BUTTON_SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
  xs: 'h-6 px-2 text-2xs gap-1 rounded-[5px]',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-md',
}

export function Button({ variant = 'secondary', size = 'sm', icon, trailing, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex select-none items-center justify-center font-medium whitespace-nowrap',
        // 140ms is under the threshold where a transition reads as lag.
        'transition-[background-color,color,border-color,filter,transform] duration-[140ms] ease-[var(--ease-out-quart)]',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {icon}
      {children}
      {trailing}
    </button>
  )
}

/** Square icon-only button. Always needs a title for the tooltip and a11y name. */
export function IconButton({
  title,
  active,
  size = 'sm',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean; size?: 'xs' | 'sm' | 'md' }) {
  const dimension = size === 'xs' ? 'size-6' : size === 'md' ? 'size-8' : 'size-7'
  return (
    <Tooltip label={title}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        {...rest}
        className={cx(
          dimension,
          'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent',
          'transition-[background-color,color,transform] duration-[140ms] ease-[var(--ease-out-quart)]',
          'active:scale-90 disabled:pointer-events-none disabled:opacity-40',
          active ? 'bg-accent-muted text-accent' : 'text-fg-tertiary hover:bg-bg-hover hover:text-fg',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/* ----------------------------------------------------------------- tooltip -- */

/**
 * CSS-positioned tooltip with a shared 500ms open delay. No portal, no
 * positioning library: every tooltip in this app sits below-left of its trigger
 * and that is enough.
 */
export function Tooltip({
  label,
  keys,
  side = 'bottom',
  children,
}: {
  label: string
  keys?: string
  side?: 'top' | 'bottom'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 480)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <span className="relative inline-flex" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide}>
      {children}
      {open && (
        <span
          role="tooltip"
          className={cx(
            'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap',
            'surface-overlay animate-fade-in rounded-md px-2 py-1 text-2xs text-fg-secondary',
            side === 'bottom' ? 'top-[calc(100%+6px)]' : 'bottom-[calc(100%+6px)]',
          )}
        >
          {label}
          {keys && <kbd className="ml-1.5 font-mono text-fg-quaternary">{keys}</kbd>}
        </span>
      )}
    </span>
  )
}

/* --------------------------------------------------------------------- kbd -- */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border-subtle bg-bg-inset px-1 font-mono text-[10px] leading-none text-fg-quaternary">
      {children}
    </kbd>
  )
}

/* ------------------------------------------------------------------- input -- */

export function Input({
  className,
  icon,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; ref?: React.Ref<HTMLInputElement> }) {
  return (
    <div className="relative flex items-center">
      {icon && <span className="pointer-events-none absolute left-2.5 text-fg-quaternary">{icon}</span>}
      <input
        ref={ref}
        {...rest}
        className={cx(
          'h-8 w-full rounded-md border border-border bg-bg-inset text-sm text-fg',
          'placeholder:text-fg-quaternary',
          'transition-[border-color,box-shadow] duration-[140ms]',
          'focus:border-accent-600 focus:outline-none focus:ring-2 focus:ring-[var(--accent-muted)]',
          icon ? 'pl-8 pr-2.5' : 'px-2.5',
          className,
        )}
      />
    </div>
  )
}

export function Textarea({
  className,
  ref,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      {...rest}
      className={cx(
        'w-full resize-none rounded-md border border-border bg-bg-inset px-2.5 py-2 text-sm text-fg',
        'placeholder:text-fg-quaternary focus:border-accent-600 focus:outline-none focus:ring-2 focus:ring-[var(--accent-muted)]',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ switch -- */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-[180ms] ease-[var(--ease-out-quart)]',
        'disabled:opacity-40',
        checked ? 'border-accent-600 bg-accent' : 'border-border bg-bg-inset',
      )}
    >
      <span
        className={cx(
          'absolute top-[2px] size-[12px] rounded-full bg-white transition-transform duration-[180ms] ease-[var(--ease-spring)]',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ slider -- */

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  format,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  label?: string
  format?: (value: number) => string
}) {
  const id = useId()
  const percent = ((value - min) / (max - min)) * 100
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-baseline justify-between">
          <label htmlFor={id} className="text-xs text-fg-secondary">
            {label}
          </label>
          <span className="tabular font-mono text-2xs text-fg-tertiary">{format ? format(value) : value}</span>
        </div>
      )}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none
          [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--bg)] [&::-webkit-slider-thumb]:bg-accent
          [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110"
        style={{
          background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${percent}%, var(--bg-inset) ${percent}%, var(--bg-inset) 100%)`,
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ dialog -- */

const DialogContext = createContext<{ close: () => void }>({ close: () => undefined })
export const useDialog = () => useContext(DialogContext)

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    // Capture so this wins over the global single-key handler.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, onClose])

  if (!open) return null
  return (
    <DialogContext.Provider value={{ close: onClose }}>
      <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={title}>
        <div
          className="animate-fade-in absolute inset-0 bg-[oklch(8%_0.01_285/0.62)] backdrop-blur-[2px]"
          onClick={onClose}
        />
        <div
          data-typing-scope="true"
          className={cx(
            'surface-overlay animate-scale-in relative w-full rounded-xl',
            'max-h-[min(78vh,780px)] overflow-hidden',
            width,
          )}
        >
          {title && (
            <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-fg">{title}</h2>
                {description && <p className="mt-0.5 text-xs text-fg-tertiary">{description}</p>}
              </div>
              <IconButton title="Close" size="xs" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </header>
          )}
          <div className="max-h-[calc(min(78vh,780px)-56px)] overflow-y-auto">{children}</div>
        </div>
      </div>
    </DialogContext.Provider>
  )
}

/* ------------------------------------------------------------- score badge -- */

const BAND_CLASSES: Record<ReturnType<typeof scoreBand>, string> = {
  critical: 'text-band-critical border-band-critical/35 bg-band-critical/12',
  high: 'text-band-high border-band-high/35 bg-band-high/12',
  medium: 'text-band-medium border-band-medium/35 bg-band-medium/12',
  low: 'text-band-low border-border-subtle bg-bg-inset',
}

export function ScoreBadge({
  score,
  size = 'sm',
  showBar = false,
}: {
  score: number
  size?: 'xs' | 'sm' | 'lg'
  showBar?: boolean
}) {
  const band = scoreBand(score)
  const dimensions =
    size === 'lg' ? 'h-8 min-w-11 text-sm' : size === 'xs' ? 'h-[18px] min-w-7 text-[10px]' : 'h-6 min-w-9 text-xs'
  return (
    <span
      className={cx(
        'relative inline-flex shrink-0 flex-col items-center justify-center overflow-hidden rounded-md border font-mono font-semibold tabular',
        dimensions,
        BAND_CLASSES[band],
      )}
      title={`Signal score ${score} / 100`}
    >
      <span className="leading-none">{score}</span>
      {showBar && (
        <span
          // Fills on mount: a 240ms width transition reads as "this was measured".
          className="absolute bottom-0 left-0 h-[2px] bg-current opacity-70"
          style={{ width: `${score}%`, animation: 'score-fill 380ms var(--ease-out-expo)' }}
        />
      )}
    </span>
  )
}

/* -------------------------------------------------------------------- misc -- */

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-bg-inset text-fg-tertiary border-border-subtle',
    accent: 'bg-accent-muted text-accent border-accent-600/30',
    success: 'bg-success-muted text-success border-success/30',
    warning: 'bg-warning-muted text-warning border-warning/30',
    danger: 'bg-danger-muted text-danger border-danger/30',
    info: 'bg-info-muted text-info border-info/30',
  }
  return (
    <span
      className={cx(
        'inline-flex h-[19px] items-center gap-1 rounded-[5px] border px-1.5 text-2xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx('animate-spin', className)}
      style={{ animationDuration: '700ms' }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="animate-fade-in flex h-full flex-col items-center justify-center px-8 py-16 text-center">
      {icon && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border-subtle bg-bg-subtle text-fg-quaternary">
          {icon}
        </div>
      )}
      <h3 className="text-balance text-sm font-semibold text-fg">{title}</h3>
      {description && <p className="text-pretty mt-1.5 max-w-[42ch] text-xs leading-relaxed text-fg-tertiary">{description}</p>}
      {action && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cx('skeleton', className)} style={style} />
}

/** Section heading used across Settings and Sources. */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary">{children}</h2>
      {hint && <p className="mt-1 text-xs text-fg-quaternary">{hint}</p>}
    </div>
  )
}

/** A horizontal sparkline. Pure SVG, no charting dependency. */
export function Sparkline({
  values,
  width = 64,
  height = 18,
  className,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
}) {
  if (values.length < 2) return <span className="inline-block" style={{ width, height }} />
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`)
  return (
    <svg width={width} height={height} className={className} aria-hidden="true" style={{ overflow: 'visible' }}>
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
