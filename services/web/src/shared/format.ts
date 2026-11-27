import { toError } from '@/api/client'
import i18n from '@/i18n'

/** Локаль Intl для текущего языка интерфейса. */
export const locale = () => {
  const l = i18n.language || 'ru'
  return l === 'kk' ? 'kk-KZ' : l === 'ru' ? 'ru-RU' : 'en-GB'
}

// --- Казахский без данных ICU. Урезанные сборки движка (часть Electron/WebView) не знают kk и пишут
// «2026 M11 27», «yesterday», «1.4M». Тогда даты и относительное время форматируем сами (по CLDR kk),
// а числа — по русским правилам: разделители у kk-KZ те же (пробел и запятая).

const KK_MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан']
const KK_MONTHS_SHORT = ['қаң.', 'ақп.', 'нау.', 'сәу.', 'мам.', 'мау.', 'шіл.', 'там.', 'қыр.', 'қаз.', 'қар.', 'жел.']
const KK_WEEKDAYS = ['жексенбі', 'дүйсенбі', 'сейсенбі', 'сәрсенбі', 'бейсенбі', 'жұма', 'сенбі']
const KK_WEEKDAYS_SHORT = ['жс', 'дс', 'сс', 'ср', 'бс', 'жм', 'сб']

let kkNative: boolean | undefined
/** Знает ли движок браузера казахский (названия месяцев по-казахски). */
export function kkIntlSupported(): boolean {
  if (kkNative === undefined) {
    try {
      const month = new Intl.DateTimeFormat('kk-KZ', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 1)))
      kkNative = /[әғқңөұүһі]/i.test(month)
    } catch {
      kkNative = false
    }
  }
  return kkNative
}
const kkFallback = () => i18n.language === 'kk' && !kkIntlSupported()
/** Локаль для чисел: без данных kk — русские правила (те же разделители). */
const numLocale = () => (kkFallback() ? 'ru-RU' : locale())

/** Дата по-казахски без Intl: «2026 ж. 27 қар.», «27 қараша, жм», «2026 ж. 27 қар., 19:06». */
export function formatKk(d: Date, o: Intl.DateTimeFormatOptions): string {
  const utc = o.timeZone === 'UTC'
  const [y, m, day, wd, h, mi, sec] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds()]
  const pad = (n: number) => String(n).padStart(2, '0')
  const ds = o.dateStyle
  const month = ds ? (ds === 'short' ? '2-digit' : ds === 'medium' ? 'short' : 'long') : o.month
  const hasDay = ds ? true : !!o.day
  const hasYear = ds ? true : !!o.year
  let date = ''
  if (month === 'numeric' || month === '2-digit') {
    date = [hasDay ? pad(day) : '', pad(m + 1), hasYear ? String(y) : ''].filter(Boolean).join('.')
  } else if (month) {
    const name = (month === 'long' ? KK_MONTHS : KK_MONTHS_SHORT)[m]
    date = hasDay ? `${day} ${name}` : name
    if (hasYear) date = `${y} ж. ${date}`
  } else if (hasDay) {
    date = String(day)
  } else if (hasYear) {
    date = `${y} ж.`
  }
  if (o.weekday) {
    const w = (o.weekday === 'long' ? KK_WEEKDAYS : KK_WEEKDAYS_SHORT)[wd]
    date = date ? `${date}, ${w}` : w
  }
  let time = ''
  if (o.timeStyle || o.hour) {
    time = `${pad(h)}:${pad(mi)}`
    if (o.timeStyle === 'medium' || o.timeStyle === 'long' || o.second) time += `:${pad(sec)}`
  }
  return [date, time].filter(Boolean).join(', ')
}

/** Диапазон по-казахски: «2026 ж. 14–27 қар.», «2026 ж. 28 қаз. – 3 қар.». */
function formatKkRange(a: Date, b: Date) {
  const [y1, m1, d1] = [a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()]
  const [y2, m2, d2] = [b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()]
  if (y1 === y2 && m1 === m2) return `${y1} ж. ${d1}–${d2} ${KK_MONTHS_SHORT[m1]}`
  if (y1 === y2) return `${y1} ж. ${d1} ${KK_MONTHS_SHORT[m1]} – ${d2} ${KK_MONTHS_SHORT[m2]}`
  const o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' } as const
  return `${formatKk(a, o)} – ${formatKk(b, o)}`
}

type RelUnit = 'second' | 'minute' | 'hour' | 'day'
const KK_UNIT = { minute: ['минут', 'минуттан'], hour: ['сағат', 'сағаттан'], day: ['күн', 'күннен'] } as const

/** Относительное время по-казахски: «жаңа ғана», «5 минут бұрын», «кеше», «3 күннен кейін». */
export function formatKkRelative(value: number, unit: RelUnit) {
  if (unit === 'second') return 'жаңа ғана'
  if (unit === 'day' && value === 0) return 'бүгін'
  if (unit === 'day' && value === -1) return 'кеше'
  if (unit === 'day' && value === 1) return 'ертең'
  const [word, from] = KK_UNIT[unit]
  const n = Math.abs(value)
  return value < 0 ? `${n} ${word} бұрын` : `${n} ${from} кейін`
}

/** Календарная дата YYYY-MM-DD (UTC) в формате Intl, без сдвига часового пояса. */
export function formatDay(iso: string, opts: Intl.DateTimeFormatOptions) {
  const d = new Date(`${iso}T00:00:00Z`)
  if (kkFallback()) return formatKk(d, { ...opts, timeZone: 'UTC' })
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(d)
}

/** Диапазон дат: «14–27 нояб. 2026 г.», «28 окт. – 3 нояб. 2026 г.». */
export function formatDayRange(from: string, to: string) {
  const a = new Date(`${from}T00:00:00Z`)
  const b = new Date(`${to}T00:00:00Z`)
  if (kkFallback()) {
    return from === to ? formatKk(a, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : formatKkRange(a, b)
  }
  const f = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return from === to ? f.format(a) : f.formatRange(a, b)
}

/** Короткая запись больших чисел: 1,2 млн, 480 тыс. */
export function formatCompact(n?: number | null) {
  if (n === undefined || n === null) return '—'
  if (Math.abs(n) < 10_000) return formatNumber(n)
  const s = new Intl.NumberFormat(numLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  return kkFallback() ? s.replace('тыс.', 'мың') : s
}

export function formatDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = {}) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const o: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', ...opts }
  if (kkFallback()) return formatKk(d, o)
  return d.toLocaleString(locale(), o)
}

export function formatRelative(iso?: string | null) {
  if (!iso) return '—'
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const kk = kkFallback()
  const intl = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  const rtf = { format: (v: number, u: RelUnit) => (kk ? formatKkRelative(v, u) : intl.format(v, u)) }
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
  return n.toLocaleString(numLocale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 })
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
