import { toError } from '@/api/client'
import i18n from '@/i18n'

const locale = () => {
  const l = i18n.language || 'ru'
  return l === 'kk' ? 'kk-KZ' : l === 'ru' ? 'ru-RU' : 'en-GB'
}

export function formatDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = {}) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short', ...opts })
}

export function formatRelative(iso?: string | null) {
  if (!iso) return '—'
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return formatDate(iso, { timeStyle: undefined })
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatNumber(n?: number | null, digits = 0) {
  if (n === undefined || n === null) return '—'
  return n.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function formatUsd(n?: number | null) {
  if (n === undefined || n === null) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

export function formatDuration(s?: number | null) {
  if (s === undefined || s === null) return '—'
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s % 60)} s`
}

/** Скачивание через fetch: работает с cookie-сессией и с MSW (навигационные запросы моки не перехватывают). */
export async function downloadFile(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'same-origin' })
  // 501 render_unavailable и прочие ошибки — с текстом от API
  if (!res.ok) throw await toError(res)
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

/** Имя файла из Content-Disposition: filename* (RFC 5987, UTF-8) важнее ASCII-запасного filename. */
export function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* битое кодирование — пробуем filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)
  return plain ? plain[1].trim() : null
}
