// Демо-вики для режима моков и тестов: заметки с папками, ссылками [[…]] и упоминаниями критериев,
// и упрощённый граф — как services/api/app/wiki.py.
import type { KnowledgeDetail, KnowledgeFolder, KnowledgeGraph, KnowledgeItem, KnowledgeSearchHit } from '@/api/types'

export type MockNote = KnowledgeItem & { _readyAt?: number; _content: string }

const key = (s: string) => s.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).join(' ')

export function links(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[\[([^[\]\n]{1,300})\]\]/g)) {
    const target = m[1].split('|')[0].trim()
    if (target && !out.includes(target)) out.push(target)
  }
  return out
}

const STEMS: Record<string, string[]> = {
  unambiguous: ['однозначн'],
  complete: ['полнот'],
  verifiable: ['проверяем'],
  correct: ['корректн'],
  traceable: ['трассируем', 'прослеживаем'],
  set_consistent: ['непротиворечив', 'противоречи'],
  set_ranked: ['ранжирован', 'приоритет'],
}

export function criteria(text: string): string[] {
  const low = text.toLowerCase().replace(/ё/g, 'е')
  return Object.entries(STEMS)
    .filter(([code, stems]) => low.includes(code) || stems.some((s) => low.includes(s)))
    .map(([code]) => code)
}

const finder = (notes: MockNote[]) => {
  const byTitle = new Map(notes.map((x) => [key(x.title), x.id]))
  return (t: string) => byTitle.get(key(t)) ?? byTitle.get(key(t.split('/').pop() ?? ''))
}

export function detail(notes: MockNote[], id: string): KnowledgeDetail | null {
  const n = notes.find((x) => x.id === id)
  if (!n) return null
  const find = finder(notes)
  const { _content, _readyAt, ...rest } = n
  void _readyAt
  return {
    ...rest,
    chars: _content.length,
    content: _content,
    links: links(_content).map((title) => ({ title, id: find(title) ?? null })),
    backlinks: notes
      .filter((x) => x.id !== id && links(x._content).some((t) => find(t) === id))
      .map((x) => ({ id: x.id, title: x.title })),
    criteria: criteria(_content),
  }
}

export const normFolder = (raw: string) =>
  raw.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..').join('/')
export const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/')
export const parentOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')
export function movePath(path: string, from: string, to: string): string {
  if (path === from) return to
  if (path.startsWith(from + '/')) {
    const rest = path.slice(from.length + 1)
    return to ? `${to}/${rest}` : rest
  }
  return path
}

/** Все папки: явно созданные и те, где лежат заметки, вместе с родителями. */
export function allFolders(notes: { folder?: string }[], explicit: string[] = []): string[] {
  const out = new Set<string>()
  ;[...notes.map((n) => n.folder ?? ''), ...explicit].forEach((f) => {
    const parts = f.split('/').filter(Boolean)
    parts.forEach((_, i) => out.add(parts.slice(0, i + 1).join('/')))
  })
  return [...out].sort()
}

export function folderList(notes: MockNote[], explicit: string[]): KnowledgeFolder[] {
  return allFolders(notes, explicit).map((path) => ({
    path,
    notes: notes.filter((n) => (n.folder ?? '') === path).length,
    total: notes.filter((n) => within(n.folder ?? '', path)).length,
    explicit: explicit.includes(path),
  }))
}

/** [[Старое]], [[Старое|подпись]], [[папка/Старое]] → [[Новое…]] */
export function renameLinks(text: string, oldTitle: string, newTitle: string): string {
  const old = key(oldTitle)
  return text.replace(/\[\[([^[\]\n]{1,300})\]\]/g, (m, inner: string) => {
    const bar = inner.indexOf('|')
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
    if (key(target) !== old && key(target.split('/').pop() ?? '') !== old) return m
    return `[[${newTitle}${bar >= 0 ? inner.slice(bar) : ''}]]`
  })
}

/** Текст без разметки Markdown для фрагментов поиска — как plain_text в services/api/app/wiki.py */
export const plainText = (text: string) =>
  text
    .replace(/\[\[([^[\]\n]{1,300})\]\]/g, (_, inner: string) => inner.split('|').pop()!.trim())
    .replace(/\|?\s*:?-{3,}:?\s*|[#*_`>|]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')

/** Как services/api/app/wiki.py search_notes: все слова запроса; совпадение в названии весит больше. */
export function search(notes: MockNote[], q: string, limit = 20): KnowledgeSearchHit[] {
  const words = key(q).split(' ').filter(Boolean)
  if (!words.length) return []
  const hits: KnowledgeSearchHit[] = []
  for (const n of notes) {
    const title = key(n.title)
    const body = n._content.toLowerCase().replace(/ё/g, 'е')
    const hay = `${title} ${key(n.folder ?? '')} ${body}`
    if (!words.every((w) => hay.includes(w))) continue
    const count = (w: string) => Math.min(5, body.split(w).length - 1)
    const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + count(w) * 0.2, 0)
    const plain = plainText(n._content)
    const low = plain.toLowerCase().replace(/ё/g, 'е')
    const pos = words.map((w) => low.indexOf(w)).filter((p) => p >= 0)
    const at = pos.length ? Math.min(...pos) : 0
    const start = Math.max(0, at - 50)
    const end = Math.min(plain.length, start + 160)
    const snippet = (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '')
    hits.push({ id: n.id, title: n.title, folder: n.folder ?? '', snippet, score: Math.round(score * 100) / 100 })
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit)
}

export function graph(notes: MockNote[], explicit: string[] = []): KnowledgeGraph {
  const find = finder(notes)
  const nodes: KnowledgeGraph['nodes'] = []
  const edges: KnowledgeGraph['edges'] = []
  allFolders(notes, explicit).forEach((f) => {
    const size = notes.filter((n) => within(n.folder ?? '', f)).length
    nodes.push({ id: `folder:${f}`, kind: 'folder', title: f.split('/').pop()!, folder: f, size })
    if (f.includes('/')) edges.push({ source: `folder:${f}`, target: `folder:${f.slice(0, f.lastIndexOf('/'))}`, kind: 'folder' })
  })
  const used = new Map<string, number>()
  notes.forEach((n) => {
    nodes.push({ id: n.id, kind: 'note', title: n.title, folder: n.folder ?? '', source: n.source, size: n._content.length })
    if (n.folder) edges.push({ source: n.id, target: `folder:${n.folder}`, kind: 'folder' })
    links(n._content).forEach((t) => {
      const target = find(t)
      if (target && target !== n.id) edges.push({ source: n.id, target, kind: 'link' })
    })
    criteria(n._content).forEach((c) => {
      used.set(c, (used.get(c) ?? 0) + 1)
      edges.push({ source: n.id, target: `criterion:${c}`, kind: 'criterion' })
    })
  })
  const TITLES: Record<string, string> = {
    unambiguous: 'Однозначность', complete: 'Полнота', verifiable: 'Проверяемость', correct: 'Корректность',
    traceable: 'Трассируемость', set_consistent: 'Непротиворечивость', set_ranked: 'Ранжированность',
  }
  used.forEach((n, c) => nodes.push({ id: `criterion:${c}`, kind: 'criterion', title: TITLES[c] ?? c, folder: '', size: n }))
  return { nodes, edges }
}

export function seedNotes(ago: (min: number) => string): MockNote[] {
  const n = (id: string, title: string, folder: string, source: KnowledgeItem['source'], content: string, minutes: number): MockNote => ({
    id, title, folder, source, chunks: Math.max(1, Math.round(content.length / 800)), status: 'ready',
    created_at: ago(minutes), updated_at: ago(Math.max(1, minutes - 30)), chars: content.length, _content: content,
  })
  return [
    n('kb-builtin', 'Критерии ISO/IEC/IEEE 29148 и IEEE 830 (пересказ)', 'Стандарты', 'builtin',
      '# Критерии качества требований\n\n## Отдельное требование\n\n- **Однозначность** — одно прочтение.\n- **Полнота** — описаны условия и реакции.\n- **Проверяемость** — есть измеримый критерий.\n- **Корректность** — без фактических ошибок.\n\n## Набор\n\n- **Непротиворечивость** — требования не спорят друг с другом.\n- **Ранжированность** — у требований есть приоритеты.\n\nСм. также [[Шаблон ТЗ банка]] и [[Глоссарий банка]].', 500),
    n('kb-glossary', 'Глоссарий банка', 'Банк', 'upload',
      '# Глоссарий банка\n\n| Термин | Определение |\n| :--- | :--- |\n| Тиын | 1/100 тенге |\n| Держатель карты | Клиент, на имя которого выпущена карта |\n| Процессинг | Система авторизации операций по картам |\n\nТермины используются в [[Шаблон ТЗ банка]]. Однозначность терминов проверяет агент.', 400),
    n('kb-template', 'Шаблон ТЗ банка', 'Банк/Шаблоны', 'manual',
      '# Шаблон ТЗ банка\n\n## Обязательные разделы\n\n1. Паспорт документа: версия, дата, согласующие\n2. Функциональные требования с идентификаторами Ф-N\n3. Нефункциональные требования с измеримыми порогами\n4. Критерии приёмки — у каждого требования\n\n> Требования без приоритета считаются дефектом ранжирования.\n\nТермины — по [[Глоссарий банка]]. Проверка — по [[Критерии ISO/IEC/IEEE 29148 и IEEE 830 (пересказ)]].', 300),
    n('kb-cards', 'Карты: лимиты и ПИН-код', 'Банк/Карты', 'manual',
      '# Карты: лимиты и ПИН-код\n\n- Лимит смены ПИН-кода — 3 попытки, блокировка 30 минут.\n- Суммы — в тенге, расчёт в тиынах, см. [[Глоссарий банка]].\n- Политика безопасности — [[Политика ИБ для мобильного банка]].\n\nПротиворечия с этими значениями в ТЗ — критический дефект.', 120),
    { ...n('kb-scan', 'Шаблон ТЗ (скан)', 'Банк/Шаблоны', 'upload', '', 380), status: 'failed', chunks: 0, error: 'В PDF нет текстового слоя — нужен OCR' },
  ]
}
