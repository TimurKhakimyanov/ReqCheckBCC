// Выпадающий список моделей с поиском (combobox в духе shadcn, на Radix Popover).
// Список виден сразу по клику; «Другая модель…» переключает на ручной ввод.
import { Check, ChevronsUpDown, ListFilter, PenLine, Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { cn } from '@/shared/utils'

interface Props {
  id?: string
  value: string
  onChange: (v: string) => void
  options: string[]
  loading?: boolean
  invalid?: boolean
  placeholder?: string
  disabled?: boolean
  'aria-describedby'?: string
}

export function ModelCombobox({ id, value, onChange, options, loading, invalid, placeholder, disabled, ...rest }: Props) {
  const { t } = useTranslation()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  }, [options, query])
  // последний пункт — «Другая модель…»
  const count = filtered.length + 1

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(Math.max(0, options.indexOf(value)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (i: number) => {
    if (i < filtered.length) {
      onChange(filtered[i])
      setManual(false)
    } else {
      setManual(true)
      if (query.trim()) onChange(query.trim())
    }
    setOpen(false)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + count) % count)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(active)
    }
  }

  if (manual)
    return (
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          autoFocus
          autoComplete="off"
          aria-invalid={invalid}
          placeholder={t('combobox.manualPlaceholder')}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          {...rest}
        />
        <button
          type="button"
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setManual(false)}
        >
          <ListFilter className="size-3.5" />
          {t('combobox.backToList')}
        </button>
      </div>
    )

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={invalid}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs transition-[border-color,box-shadow] outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.03]',
            invalid && 'border-destructive ring-[3px] ring-destructive/15',
          )}
          {...rest}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground/80')}>{value || placeholder || t('combobox.choose')}</span>
          {loading ? <Spinner className="size-3.5 text-muted-foreground" /> : <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-raised"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).querySelector('input')?.focus()
          }}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/80"
              placeholder={t('combobox.search')}
              value={query}
              role="searchbox"
              aria-controls={listId}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKey}
            />
          </div>
          <ul id={listId} ref={listRef} role="listbox" aria-label={t('combobox.models')} className="max-h-64 overflow-y-auto p-1">
            {loading && !options.length && (
              <li className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                <Spinner className="size-3.5" /> {t('common.loading')}
              </li>
            )}
            {!loading && !filtered.length && (
              <li className="px-2 py-2 text-sm text-muted-foreground">{options.length ? t('combobox.noMatches') : t('combobox.empty')}</li>
            )}
            {filtered.map((o, i) => (
              <li
                key={o}
                role="option"
                data-index={i}
                aria-selected={o === value}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-mono text-[0.8125rem]',
                  i === active && 'bg-accent',
                )}
              >
                <Check className={cn('size-3.5 shrink-0 text-primary', o !== value && 'invisible')} />
                <span className="truncate">{o}</span>
              </li>
            ))}
            <li
              role="option"
              aria-selected={false}
              data-index={filtered.length}
              onMouseEnter={() => setActive(filtered.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(filtered.length)}
              className={cn(
                'mt-1 flex cursor-pointer items-center gap-2 rounded-lg border-t px-2 py-1.5 text-sm text-muted-foreground',
                active === filtered.length && 'bg-accent text-foreground',
              )}
            >
              <PenLine className="size-3.5 shrink-0" />
              {query.trim() ? t('combobox.useTyped', { value: query.trim() }) : t('combobox.other')}
            </li>
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
