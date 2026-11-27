// Языки интерфейса подхватываются автоматически: каждый файл src/locales/<код>.json — отдельный язык.
// Добавить язык = положить новый файл (ключ _meta.name — название языка для переключателя).
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

type LocaleFile = { _meta?: { name?: string; ready?: boolean } } & Record<string, unknown>

const modules = import.meta.glob<LocaleFile>('../locales/*.json', { eager: true, import: 'default' })

export const resources: Record<string, { translation: LocaleFile }> = {}
export const languages: { code: string; name: string; ready: boolean }[] = []

for (const [path, data] of Object.entries(modules)) {
  const code = path.match(/([\w-]+)\.json$/)![1]
  resources[code] = { translation: data }
  languages.push({ code, name: data._meta?.name ?? code, ready: data._meta?.ready !== false })
}
const order = ['ru', 'en', 'kk']
languages.sort((a, b) => (order.indexOf(a.code) + 1 || 99) - (order.indexOf(b.code) + 1 || 99))

export const LANG_STORAGE_KEY = 'reqcheck.lang'
export const DEFAULT_LANG = 'ru'

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY)
    if (saved && resources[saved]) return saved
  } catch {
    /* хранилище недоступно */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language?.slice(0, 2) : undefined
  return nav && resources[nav] ? nav : DEFAULT_LANG
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  // Недопереведённый казахский показывает русский, остальные — английский, затем русский.
  fallbackLng: { kk: ['ru'], default: ['en', 'ru'] },
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
})

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lng)
  } catch {
    /* ignore */
  }
})
if (typeof document !== 'undefined') document.documentElement.lang = i18n.language

export default i18n
