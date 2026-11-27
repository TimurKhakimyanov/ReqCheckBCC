// Выбор периода в стиле ReqCheck вместо системного input type="date":
// быстрые пресеты, два месяца с выделением диапазона, ручной ввод дат «дд.мм.гггг», клавиатура (стрелки, Home/End).
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { addDays, addMonths, daysInclusive, formatDmy, monthCells, monthStart, parseDmy, todayIso, weekdayIndex } from '@/shared/dates'
import { formatDay, formatDayRange } from '@/shared/format'
import { cn } from '@/shared/utils'

export interface DateRange {
  /** YYYY-MM-DD, включительно */
  from: string
  /** YYYY-MM-DD, включительно */
  to: string
}

export const DATE_PRESETS = ['today', 'yesterday', 'last7', 'last14', 'last30', 'thisMonth', 'lastMonth', 'last90', 'ytd'] as const
export type DatePreset = (typeof DATE_PRESETS)[number]

export function presetRange(key: DatePreset, today: string): DateRange {
  const last = (n: number) => ({ from: addDays(today, -(n - 1)), to: today })
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) }
    case 'last7':
      return last(7)
    case 'last14':
      return last(14)
    case 'last30':
      return last(30)
    case 'last90':
      return last(90)
    case 'thisMonth':
      return { from: monthStart(today), to: today }
    case 'lastMonth':
      return { from: addMonths(today, -1), to: addDays(monthStart(today), -1) }
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today }
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function DateRangePicker({
  value,
  onChange,
  max = todayIso(),
  id,
  highlight = false,
  className,
  'aria-labelledby': labelledBy,
}: {
  value: DateRange
  onChange: (range: DateRange) => void
  /** Последний доступный день (по умолчанию сегодня, UTC). */
  max?: string
  id?: string
  /** Подсветить поле: выбран свой период, а не быстрый пресет снаружи. */
  highlight?: boolean
  className?: string
  'aria-labelledby'?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const autoId = useId()
  const triggerId = id ?? `drp-${autoId}`
  const count = daysInclusive(value.from, value.to)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={triggerId}
          type="button"
          aria-haspopup="dialog"
          aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
          className={cn(
            'flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-input bg-card px-3 text-[13px] font-medium whitespace-nowrap shadow-xs transition-[border-color,box-shadow] outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 dark:bg-white/[0.03]',
            open ? 'border-ring ring-[3px] ring-ring/15' : highlight && 'border-primary/60 ring-[3px] ring-primary-tint',
            className,
          )}
        >
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="tabular-nums">{formatDayRange(value.from, value.to)}</span>
          <span className="font-normal text-muted-foreground">· {t('dateRange.days', { count })}</span>
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('dateRange.dialog')}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(720px,calc(100vw-24px))] overflow-x-hidden overflow-y-auto rounded-2xl bg-popover text-popover-foreground shadow-raised outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus()
          }}
        >
          <RangePanel
            value={value}
            max={max}
            onCancel={() => setOpen(false)}
            onApply={(r) => {
              onChange(r)
              setOpen(false)
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function RangePanel({
  value,
  max,
  onApply,
  onCancel,
}: {
  value: DateRange
  max: string
  onApply: (range: DateRange) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const ids = useId()
  const [start, setStart] = useState<string | null>(value.from)
  const [end, setEnd] = useState<string | null>(value.to)
  const [hover, setHover] = useState<string | null>(null)
  /** Первый день левого месяца; справа — следующий месяц. */
  const [view, setView] = useState(() => addMonths(value.to, -1))
  const [focusDay, setFocusDay] = useState<string | null>(null)
  const [fromText, setFromText] = useState<string | null>(null)
  const [toText, setToText] = useState<string | null>(null)
  const [bad, setBad] = useState<'from' | 'to' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const today = todayIso()

  useEffect(() => {
    if (focusDay) rootRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus()
  }, [focusDay, view])

  const resetText = () => {
    setFromText(null)
    setToText(null)
    setBad(null)
  }
  const showRange = (r: DateRange) => {
    setStart(r.from)
    setEnd(r.to)
    setHover(null)
    setView(addMonths(r.to, -1))
    resetText()
  }
  const pick = (d: string) => {
    if (!start || end) {
      setStart(d)
      setEnd(null)
    } else if (d < start) setStart(d)
    else setEnd(d)
    setHover(null)
    resetText()
  }
  const commit = (which: 'from' | 'to') => {
    const text = which === 'from' ? fromText : toText
    if (text === null) return
    const d = parseDmy(text)
    if (!d || d > max || (which === 'from' ? !!end && d > end : !!start && d < start)) {
      setBad(which)
      return
    }
    if (which === 'from') {
      setStart(d)
      setFromText(null)
      if (!end) setView(monthStart(d))
    } else {
      setEnd(d)
      setToText(null)
      setView(addMonths(d, -1))
    }
    setBad(null)
  }

  const visible = (d: string | null): d is string => !!d && d >= view && d < addMonths(view, 2)
  const tabDay = [focusDay, end, start, today].find(visible) ?? view
  const previewEnd = end ?? (start && hover && hover >= start ? hover : null)
  const nextDisabled = addMonths(view, 1) >= monthStart(max)
  const weekdays = Array.from({ length: 7 }, (_, i) => capitalize(formatDay(addDays('2024-01-01', i), { weekday: 'short' })))
  const count = start && end ? daysInclusive(start, end) : 0
  const hint = bad
    ? t('dateRange.invalid')
    : !start
      ? t('dateRange.pickStart')
      : !end
        ? t('dateRange.pickEnd')
        : t('dateRange.days', { count })

  const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const day = (e.target as HTMLElement).dataset.day
    if (!day) return
    let next: string | undefined
    if (e.key in STEP) next = addDays(day, STEP[e.key])
    else if (e.key === 'Home') next = addDays(day, -weekdayIndex(day))
    else if (e.key === 'End') next = addDays(day, 6 - weekdayIndex(day))
    else if (e.key === 'PageUp') next = addMonths(day, -1)
    else if (e.key === 'PageDown') next = addMonths(day, 1)
    if (!next) return
    e.preventDefault()
    if (next > max) next = max
    if (next < view) setView(monthStart(next))
    else if (next >= addMonths(view, 2)) setView(addMonths(next, -1))
    setFocusDay(next)
    if (start && !end) setHover(next)
  }

  return (
    <div ref={rootRef} className="grid sm:grid-cols-[176px_minmax(0,1fr)]">
      <div
        role="group"
        aria-labelledby={`${ids}-quick`}
        className="flex gap-1 overflow-x-auto border-b bg-secondary/60 p-2 sm:flex-col sm:gap-0.5 sm:overflow-visible sm:border-r sm:border-b-0 sm:p-2.5"
      >
        <span id={`${ids}-quick`} className="sr-only px-2.5 pt-1.5 pb-2 text-xs font-medium text-muted-foreground sm:not-sr-only">
          {t('dateRange.quick')}
        </span>
        {DATE_PRESETS.map((key) => {
          const r = presetRange(key, max)
          const on = start === r.from && end === r.to
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => showRange(r)}
              className={cn(
                'flex h-8 shrink-0 cursor-pointer items-center justify-between gap-2 rounded-[9px] px-2.5 text-left text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on ? 'bg-primary-tint font-medium text-primary-strong' : 'hover:bg-accent',
              )}
            >
              {t(`dateRange.${key}`)}
              {on && <Check className="size-3.5" aria-hidden />}
            </button>
          )
        })}
      </div>

      <div className="flex min-w-0 flex-col">
        <div className="grid gap-x-7 gap-y-5 px-5 pt-4 pb-3 sm:grid-cols-2" onKeyDown={onGridKey} onMouseLeave={() => setHover(null)}>
          {[view, addMonths(view, 1)].map((month, idx) => {
            const lastDay = addDays(addMonths(month, 1), -1)
            const title = `${capitalize(formatDay(month, { month: 'long' }))} ${month.slice(0, 4)}`
            return (
              // на телефоне виден один месяц (правый), стрелка «назад» переезжает к нему
              <div key={month} className={cn('min-w-0', idx === 0 && 'hidden sm:block')}>
                <div className="mb-2 grid h-8 grid-cols-[32px_minmax(0,1fr)_32px] items-center">
                  {idx === 0 ? (
                    <NavButton label={t('dateRange.prevMonth')} onClick={() => setView(addMonths(view, -1))}>
                      <ChevronLeft />
                    </NavButton>
                  ) : (
                    <NavButton label={t('dateRange.prevMonth')} className="sm:invisible" onClick={() => setView(addMonths(view, -1))}>
                      <ChevronLeft />
                    </NavButton>
                  )}
                  <span className="text-center text-sm font-semibold tracking-tight" aria-live="polite">
                    {title}
                  </span>
                  {idx === 1 ? (
                    <NavButton label={t('dateRange.nextMonth')} disabled={nextDisabled} onClick={() => setView(addMonths(view, 1))}>
                      <ChevronRight />
                    </NavButton>
                  ) : (
                    <span />
                  )}
                </div>
                <div aria-hidden className="mb-1 grid grid-cols-7">
                  {weekdays.map((w) => (
                    <span key={w} className="flex h-6 items-center justify-center text-[11px] font-medium text-muted-foreground">
                      {w}
                    </span>
                  ))}
                </div>
                <div role="group" aria-label={title} className="grid grid-cols-7 gap-y-0.5">
                  {monthCells(month).map((d, i) => {
                    if (!d) return <span key={`e${i}`} aria-hidden className="h-9" />
                    const col = weekdayIndex(d)
                    const disabled = d > max
                    const isStart = d === start
                    const isEnd = !!previewEnd && d === previewEnd
                    const single = isStart && (!previewEnd || previewEnd === start)
                    const inRange = !!start && !!previewEnd && d > start && d < previewEnd
                    const preview = isEnd && !end && !isStart
                    const filled = (isStart || isEnd) && !preview
                    const rowStart = col === 0 || d === month
                    const rowEnd = col === 6 || d === lastDay
                    return (
                      <div
                        key={d}
                        className={cn(
                          'h-9',
                          inRange && 'bg-primary-tint',
                          inRange && rowStart && 'rounded-l-[10px]',
                          inRange && rowEnd && 'rounded-r-[10px]',
                          isStart && !single && !rowEnd && 'bg-[linear-gradient(to_right,transparent_50%,var(--primary-tint)_50%)]',
                          isEnd && !single && !rowStart && 'bg-[linear-gradient(to_left,transparent_50%,var(--primary-tint)_50%)]',
                        )}
                      >
                        <button
                          type="button"
                          data-day={d}
                          tabIndex={d === tabDay ? 0 : -1}
                          disabled={disabled}
                          aria-pressed={isStart || isEnd}
                          aria-current={d === today ? 'date' : undefined}
                          aria-label={formatDay(d, { day: 'numeric', month: 'long', year: 'numeric' })}
                          onClick={() => pick(d)}
                          onMouseEnter={() => !disabled && setHover(d)}
                          className={cn(
                            'relative flex size-full items-center justify-center rounded-[10px] text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            disabled ? 'cursor-not-allowed text-muted-foreground/40' : 'cursor-pointer',
                            filled && 'bg-primary-strong font-semibold text-primary-foreground',
                            preview && 'font-semibold ring-[1.5px] ring-primary-strong ring-inset',
                            !filled && !preview && !disabled && 'hover:bg-accent',
                          )}
                        >
                          {Number(d.slice(8))}
                          {d === today && (
                            <span
                              aria-hidden
                              className={cn(
                                'absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full',
                                filled ? 'bg-primary-foreground' : 'bg-primary',
                              )}
                            />
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-auto flex flex-wrap items-end gap-x-3 gap-y-2.5 border-t px-5 pt-3 pb-4">
          <DateField
            id={`${ids}-from`}
            label={t('dateRange.from')}
            placeholder={t('dateRange.placeholder')}
            value={fromText ?? formatDmy(start)}
            invalid={bad === 'from'}
            onChange={(v) => {
              setFromText(v)
              setBad(null)
            }}
            onCommit={() => commit('from')}
          />
          <span aria-hidden className="flex h-9 items-center text-muted-foreground">
            —
          </span>
          <DateField
            id={`${ids}-to`}
            label={t('dateRange.to')}
            placeholder={t('dateRange.placeholder')}
            value={toText ?? formatDmy(end)}
            invalid={bad === 'to'}
            active={!!start && !end}
            onChange={(v) => {
              setToText(v)
              setBad(null)
            }}
            onCommit={() => commit('to')}
          />
          <span
            aria-live="polite"
            className={cn('flex h-9 min-w-[120px] flex-1 items-center text-xs', bad ? 'text-destructive' : 'text-muted-foreground')}
          >
            {hint}
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!start || !end} onClick={() => start && end && onApply({ from: start, to: end })}>
              {t('dateRange.apply')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function NavButton({
  label,
  disabled,
  className,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  className?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-8 cursor-pointer items-center justify-center rounded-[9px] border border-border text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-4',
        className,
      )}
    >
      {children}
    </button>
  )
}

function DateField({
  id,
  label,
  placeholder,
  value,
  invalid,
  active,
  onChange,
  onCommit,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  invalid: boolean
  active?: boolean
  onChange: (v: string) => void
  onCommit: () => void
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit()
          }
        }}
        className={cn('w-[124px] text-[13px] tabular-nums', active && !invalid && 'border-ring ring-[3px] ring-ring/15')}
      />
    </div>
  )
}
