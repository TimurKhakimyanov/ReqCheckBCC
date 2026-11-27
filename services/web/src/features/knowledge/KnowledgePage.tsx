// База знаний как вики: дерево папок слева, заметка (просмотр или редактор Markdown с живым превью) в центре,
// оглавление, ссылки, обратные ссылки и критерии справа; отдельный вид — граф связей.
// Состояние в URL: ?note=<id>, ?folder=<путь>, ?view=graph — ссылкой на заметку можно поделиться.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  Network,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react'
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { KnowledgeDetail, KnowledgeItem } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { EmptyState, ErrorNote, Skeleton, Spinner } from '@/components/ui/misc'
import { formatDate, formatNumber } from '@/shared/format'
import { cn } from '@/shared/utils'
import { FOLDER_COLORS, KnowledgeGraphView, topFolder } from './KnowledgeGraph'
import { parseBlocks, slug, WikiMarkdown } from './WikiMarkdown'

interface TreeNode {
  name: string
  path: string
  folders: TreeNode[]
  notes: KnowledgeItem[]
  total: number
}

export function buildTree(items: KnowledgeItem[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], notes: [], total: 0 }
  for (const it of items) {
    let node = root
    node.total++
    const parts = (it.folder ?? '').split('/').filter(Boolean)
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let next = node.folders.find((f) => f.path === path)
      if (!next) {
        next = { name: part, path, folders: [], notes: [], total: 0 }
        node.folders.push(next)
      }
      next.total++
      node = next
    })
    node.notes.push(it)
  }
  const sort = (n: TreeNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    n.notes.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    n.folders.forEach(sort)
  }
  sort(root)
  return root
}

const key = (s: string) => s.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).join(' ')

interface Draft {
  id: string | null
  title: string
  folder: string
  text: string
}

export function KnowledgePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const noteId = params.get('note')
  const folder = params.get('folder') ?? ''
  const view = params.get('view') === 'graph' ? 'graph' : 'note'
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)

  const go = (next: { note?: string | null; folder?: string | null; view?: 'graph' | 'note' }) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === undefined || v === '' || (k === 'view' && v === 'note')) n.delete(k)
          else n.set(k, v)
        }
        return n
      },
      { replace: false },
    )

  const items = useQuery({
    queryKey: ['knowledge'],
    queryFn: api.knowledge,
    refetchInterval: (query) => (query.state.data?.some((k) => k.status === 'indexing') ? 2000 : false),
  })
  const detail = useQuery({
    queryKey: ['knowledge', noteId],
    queryFn: () => api.knowledgeItem(noteId!),
    enabled: !!noteId,
  })
  const graph = useQuery({ queryKey: ['knowledge', 'graph'], queryFn: api.knowledgeGraph, enabled: view === 'graph' })

  const all = useMemo(() => items.data ?? [], [items.data])
  const filtered = useMemo(() => (q.trim() ? all.filter((i) => key(`${i.title} ${i.folder ?? ''}`).includes(key(q))) : all), [all, q])
  const tree = useMemo(() => buildTree(filtered), [filtered])
  const folders = useMemo(() => [...new Set(all.flatMap((i) => (i.folder ?? '').split('/').map((_, k, a) => a.slice(0, k + 1).join('/'))).filter(Boolean))].sort(), [all])
  const byTitle = useMemo(() => new Map(all.map((i) => [key(i.title), i.id])), [all])
  const tops = useMemo(() => [...new Set(all.map((i) => topFolder(i.folder ?? '')))].sort(), [all])
  const colorOf = (f: string) => FOLDER_COLORS[Math.max(0, tops.indexOf(topFolder(f))) % FOLDER_COLORS.length]

  const refresh = () => qc.invalidateQueries({ queryKey: ['knowledge'] })
  const save = useMutation({
    mutationFn: async (d: Draft) =>
      d.id ? api.updateKnowledge(d.id, { title: d.title.trim(), folder: d.folder, text: d.text }) : api.addKnowledgeText(d.title.trim(), d.text, d.folder),
    onSuccess: (item) => {
      toast.success(t('wiki.saved'))
      setDraft(null)
      void refresh()
      go({ note: item.id, folder: null, view: 'note' })
    },
    onError: (e) => toast.error(e.message),
  })
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.updateKnowledge(id, { folder: to }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e.message),
  })
  const upload = useMutation({
    mutationFn: (f: File) => api.uploadKnowledge(f, currentFolder()),
    onSuccess: (item) => {
      toast.success(t('knowledge.added'))
      void refresh()
      go({ note: item.id, folder: null, view: 'note' })
    },
    onError: (e) => toast.error(e.message),
  })
  const del = useMutation({
    mutationFn: api.deleteKnowledge,
    onSuccess: () => {
      go({ note: null })
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const note = detail.data
  function currentFolder() {
    return folder || (note?.folder ?? '')
  }
  const newNote = (title = '') => {
    go({ view: 'note' })
    setDraft({ id: null, title, folder: currentFolder(), text: title ? `# ${title}\n\n` : '' })
  }
  const editNote = (n: KnowledgeDetail) => setDraft({ id: n.id, title: n.title, folder: n.folder ?? '', text: n.content })
  // сначала полное название (в нём может быть «/»), затем без пути папки: [[Банк/Глоссарий]]
  const resolve = (title: string) => ({ id: byTitle.get(key(title)) ?? byTitle.get(key(title.split('/').pop() ?? '')) ?? null })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const id = e.dataTransfer.getData('text/reqcheck-note')
    const to = (e.target as HTMLElement).closest('[data-folder]')?.getAttribute('data-folder')
    if (id && to !== null && to !== undefined) {
      move.mutate({ id, to })
      return
    }
    Array.from(e.dataTransfer.files).forEach((f) => upload.mutate(f))
  }

  const Folders = ({ node, depth }: { node: TreeNode; depth: number }): ReactNode => (
    <>
      {node.folders.map((f) => {
        const open = q.trim() !== '' || !closed.has(f.path)
        const active = folder === f.path && !noteId
        return (
          <li key={f.path}>
            <div
              data-folder={f.path}
              className={cn('group flex min-h-8 items-center gap-1 pr-2 text-sm hover:bg-accent', active && 'bg-accent font-medium')}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <button
                type="button"
                aria-label={open ? t('wiki.collapse') : t('wiki.expand')}
                aria-expanded={open}
                onClick={() =>
                  setClosed((s) => {
                    const n = new Set(s)
                    if (n.has(f.path)) n.delete(f.path)
                    else n.add(f.path)
                    return n
                  })
                }
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground"
              >
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
              <button type="button" onClick={() => go({ folder: f.path, note: null, view: 'note' })} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
                {open ? <FolderOpen className="size-4 shrink-0" style={{ color: colorOf(f.path) }} /> : <Folder className="size-4 shrink-0" style={{ color: colorOf(f.path) }} />}
                <span className="truncate">{f.name}</span>
              </button>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">{f.total}</span>
            </div>
            {open && (
              <ul>
                <Folders node={f} depth={depth + 1} />
              </ul>
            )}
          </li>
        )
      })}
      {node.notes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/reqcheck-note', n.id)}
            onClick={() => go({ note: n.id, folder: null, view: 'note' })}
            aria-current={n.id === noteId ? 'page' : undefined}
            className={cn(
              'flex min-h-8 w-full cursor-pointer items-center gap-2 pr-2 text-left text-sm hover:bg-accent',
              n.id === noteId && 'bg-primary-tint font-medium shadow-[inset_2px_0_0_var(--primary)]',
            )}
            style={{ paddingLeft: 12 + depth * 14 + 18 }}
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{n.title}</span>
            {n.status === 'indexing' && <Spinner className="size-3" />}
            {n.status === 'failed' && <span className="size-1.5 shrink-0 bg-destructive" title={n.error ?? ''} />}
          </button>
        </li>
      ))}
    </>
  )

  const folderNotes = useMemo(() => all.filter((i) => (i.folder ?? '') === folder || (folder && (i.folder ?? '').startsWith(folder + '/'))), [all, folder])

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Дерево */}
      <aside
        className={cn('flex max-h-[45vh] shrink-0 flex-col border-b bg-panel lg:max-h-none lg:w-72 lg:border-r lg:border-b-0', dropping && 'bg-primary-tint')}
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex items-center justify-between">
            <h1 className="label-mono flex items-center gap-2">
              <span aria-hidden className="inline-block size-1.5 bg-primary" />
              {t('knowledge.title')}
            </h1>
            <span className="font-mono text-[0.6875rem] text-muted-foreground">{all.length}</span>
          </div>
          <label className="flex h-8 items-center gap-2 border border-input bg-card px-2">
            <Search className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{t('wiki.search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('wiki.search')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" onClick={() => newNote()}>
              <FilePlus2 />
              {t('wiki.newNote')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => file.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Spinner /> : <FileUp />}
              {t('wiki.upload')}
            </Button>
          </div>
          <input
            ref={file}
            type="file"
            hidden
            multiple
            accept=".pdf,.docx,.md,.txt"
            data-testid="kb-file"
            onChange={(e) => {
              Array.from(e.target.files ?? []).forEach((f) => upload.mutate(f))
              e.target.value = ''
            }}
          />
          <div className="grid grid-cols-2 gap-1 border p-0.5" role="tablist" aria-label={t('wiki.view')}>
            {(['note', 'graph'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => go({ view: v })}
                className={cn('flex min-h-7 cursor-pointer items-center justify-center gap-1.5 text-xs', view === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {v === 'graph' ? <Network className="size-3.5" /> : <BookOpen className="size-3.5" />}
                {t(`wiki.view_${v}`)}
              </button>
            ))}
          </div>
        </div>
        <nav aria-label={t('wiki.tree')} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {items.isPending ? (
            <div className="grid gap-2 p-3">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : (
            <ul data-folder="">
              <li>
                <button
                  type="button"
                  data-folder=""
                  onClick={() => go({ folder: null, note: null, view: 'note' })}
                  className={cn('flex min-h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm hover:bg-accent', !folder && !noteId && view === 'note' && 'bg-accent font-medium')}
                >
                  <BookOpen className="size-4 text-muted-foreground" />
                  {t('wiki.home')}
                </button>
              </li>
              <Folders node={tree} depth={0} />
            </ul>
          )}
          {items.data && !filtered.length && <p className="px-3 py-4 text-xs text-muted-foreground">{t('wiki.nothingFound')}</p>}
        </nav>
        <p className="hidden border-t px-3 py-2 text-[0.6875rem] text-muted-foreground lg:block">{t('wiki.dropHint')}</p>
      </aside>

      {/* Содержимое */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {items.error && <div className="p-4"><ErrorNote error={items.error} /></div>}
        {view === 'graph' ? (
          graph.data ? (
            <KnowledgeGraphView graph={graph.data} selected={noteId} colorOf={colorOf} onOpen={(id) => go({ note: id, view: 'note', folder: null })} />
          ) : graph.error ? (
            <div className="p-4"><ErrorNote error={graph.error} /></div>
          ) : (
            <Skeleton className="m-6 h-96" />
          )
        ) : draft ? (
          <Editor draft={draft} setDraft={setDraft} folders={folders} saving={save.isPending} onSave={() => save.mutate(draft)} onCancel={() => setDraft(null)} resolve={resolve} builtin={!!draft.id && note?.source === 'builtin'} />
        ) : noteId ? (
          detail.data ? (
            <NoteView
              note={detail.data}
              resolve={resolve}
              onOpen={(id) => go({ note: id })}
              onCreate={newNote}
              onFolder={(f) => go({ folder: f, note: null })}
              onEdit={() => editNote(detail.data!)}
              onDelete={() => window.confirm(t('knowledge.confirmDelete', { name: detail.data!.title })) && del.mutate(detail.data!.id)}
              onGraph={() => go({ view: 'graph' })}
            />
          ) : detail.error ? (
            <div className="p-4"><ErrorNote error={detail.error} /></div>
          ) : (
            <Skeleton className="m-6 h-96" />
          )
        ) : (
          <FolderView
            folder={folder}
            notes={folderNotes}
            all={all}
            colorOf={colorOf}
            onOpen={(id) => go({ note: id, folder: null })}
            onNew={() => newNote()}
            onGraph={() => go({ view: 'graph' })}
          />
        )}
      </main>
    </div>
  )
}

function Crumbs({ folder, onFolder }: { folder: string; onFolder: (f: string | null) => void }) {
  const { t } = useTranslation()
  const parts = folder.split('/').filter(Boolean)
  return (
    <nav aria-label={t('wiki.path')} className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
      <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => onFolder(null)}>
        {t('wiki.home')}
      </button>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          <ChevronRight className="size-3" />
          <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => onFolder(parts.slice(0, i + 1).join('/'))}>
            {p}
          </button>
        </span>
      ))}
    </nav>
  )
}

function NoteView({
  note,
  resolve,
  onOpen,
  onCreate,
  onFolder,
  onEdit,
  onDelete,
  onGraph,
}: {
  note: KnowledgeDetail
  resolve: (title: string) => { id: string | null }
  onOpen: (id: string) => void
  onCreate: (title: string) => void
  onFolder: (f: string | null) => void
  onEdit: () => void
  onDelete: () => void
  onGraph: () => void
}) {
  const { t } = useTranslation()
  const toc = parseBlocks(note.content).filter((b) => b.type === 'h' && (b.level ?? 9) <= 3)
  const builtin = note.source === 'builtin'
  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <article className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 border-b bg-background/95 px-6 py-4 backdrop-blur">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Crumbs folder={note.folder ?? ''} onFolder={onFolder} />
            <h2 className="text-2xl font-medium tracking-tight">{note.title}</h2>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
              <Badge variant="outline">{t(`knowledge.src.${note.source}`)}</Badge>
              <Badge variant={note.status === 'ready' ? 'success' : note.status === 'failed' ? 'destructive' : 'secondary'}>
                {note.status === 'indexing' && <Spinner className="size-3" />}
                {t(`knowledge.st.${note.status}`)}
              </Badge>
              <span>{t('wiki.chars', { n: formatNumber(note.chars ?? note.content.length) })}</span>
              <span>· {t('wiki.chunks', { n: note.chunks })}</span>
              <span>· {formatDate(note.updated_at ?? note.created_at)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={onEdit} title={builtin ? t('wiki.builtinMoveOnly') : undefined}>
              <Pencil />
              {builtin ? t('wiki.move') : t('wiki.edit')}
            </Button>
            <Button size="sm" variant="outline" onClick={onGraph}>
              <Network />
              {t('wiki.view_graph')}
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={onDelete} disabled={builtin} aria-label={t('common.delete')} title={builtin ? t('knowledge.builtinHint') : t('common.delete')}>
              <Trash2 />
            </Button>
          </div>
        </header>
        {note.status === 'failed' && note.error && <div className="px-6 pt-4"><ErrorNote error={note.error} /></div>}
        <div className="mx-auto max-w-3xl px-6 py-6">
          <WikiMarkdown text={note.content} resolve={resolve} onOpen={onOpen} onCreate={onCreate} missingHint={t('wiki.missingLink')} />
        </div>
      </article>

      <aside className="flex shrink-0 flex-col gap-5 overflow-y-auto border-t bg-panel p-4 xl:w-72 xl:border-t-0 xl:border-l">
        {toc.length > 1 && (
          <Section title={t('wiki.toc')}>
            <ul className="grid gap-1 text-sm">
              {toc.map((h, i) => (
                <li key={i} style={{ paddingLeft: ((h.level ?? 1) - 1) * 12 }}>
                  <a href={`#${slug(h.lines[0])}`} className="text-muted-foreground hover:text-foreground">
                    {h.lines[0].replace(/[*_`[\]]/g, '')}
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title={t('wiki.links')} count={note.links.length}>
          {note.links.length ? (
            <ul className="grid gap-1 text-sm">
              {note.links.map((l, i) => (
                <li key={i}>
                  {l.id ? (
                    <button type="button" className="cursor-pointer text-left text-accent-2 hover:underline" onClick={() => onOpen(l.id!)}>
                      {l.title}
                    </button>
                  ) : (
                    <button type="button" className="cursor-pointer text-left text-destructive hover:underline" onClick={() => onCreate(l.title)} title={t('wiki.missingLink')}>
                      {l.title} <span className="font-mono text-[0.6875rem]">+</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('wiki.noLinks')}</p>
          )}
        </Section>
        <Section title={t('wiki.backlinks')} count={note.backlinks.length}>
          {note.backlinks.length ? (
            <ul className="grid gap-1 text-sm">
              {note.backlinks.map((b) => (
                <li key={b.id}>
                  <button type="button" className="cursor-pointer text-left text-accent-2 hover:underline" onClick={() => onOpen(b.id)}>
                    {b.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('wiki.noBacklinks')}</p>
          )}
        </Section>
        <Section title={t('wiki.criteria')} count={note.criteria.length}>
          {note.criteria.length ? (
            <div className="flex flex-wrap gap-1.5">
              {note.criteria.map((c) => (
                <span key={c} className="border border-teal/50 px-2 py-0.5 text-xs text-teal">
                  {t(`criteria.${c}.title`)}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('wiki.noCriteria')}</p>
          )}
        </Section>
      </aside>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="label-mono flex justify-between">
        <span>{title}</span>
        {count !== undefined && <span>{count}</span>}
      </h3>
      {children}
    </section>
  )
}

const SNIPPETS: { key: string; wrap?: [string, string]; insert?: string }[] = [
  { key: 'h2', insert: '\n## ' },
  { key: 'bold', wrap: ['**', '**'] },
  { key: 'italic', wrap: ['_', '_'] },
  { key: 'list', insert: '\n- ' },
  { key: 'link', wrap: ['[[', ']]'] },
  { key: 'table', insert: '\n| Колонка | Значение |\n| :--- | :--- |\n|  |  |\n' },
  { key: 'code', wrap: ['`', '`'] },
]

function Editor({
  draft,
  setDraft,
  folders,
  saving,
  onSave,
  onCancel,
  resolve,
  builtin,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  folders: string[]
  saving: boolean
  onSave: () => void
  onCancel: () => void
  resolve: (title: string) => { id: string | null }
  builtin: boolean
}) {
  const { t } = useTranslation()
  const area = useRef<HTMLTextAreaElement>(null)
  const apply = (s: (typeof SNIPPETS)[number]) => {
    const el = area.current
    if (!el) return
    const { selectionStart: a, selectionEnd: b, value } = el
    const next = s.wrap ? value.slice(0, a) + s.wrap[0] + value.slice(a, b) + s.wrap[1] + value.slice(b) : value.slice(0, a) + s.insert + value.slice(b)
    setDraft({ ...draft, text: next })
    const caret = s.wrap ? b + s.wrap[0].length : a + (s.insert?.length ?? 0)
    requestAnimationFrame?.(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (draft.title.trim() && draft.text.trim()) onSave()
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-end gap-3 border-b px-6 py-4">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <Label htmlFor="wiki-title" className="label-mono">{t('knowledge.name')}</Label>
          <Input id="wiki-title" value={draft.title} disabled={builtin} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus={!draft.id} />
        </div>
        <div className="grid min-w-48 gap-1.5">
          <Label htmlFor="wiki-folder" className="label-mono">{t('wiki.folder')}</Label>
          <Input id="wiki-folder" list="wiki-folders" value={draft.folder} placeholder={t('wiki.folderHint')} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} />
          <datalist id="wiki-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={saving || !draft.title.trim() || !draft.text.trim()}>
            {saving && <Spinner />}
            {t('common.save')}
          </Button>
        </div>
      </div>
      {builtin ? (
        <p className="px-6 py-4 text-sm text-muted-foreground">{t('wiki.builtinMoveOnly')}</p>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-2">
          <div className="flex min-h-[320px] flex-col border-b lg:border-r lg:border-b-0">
            <div role="toolbar" aria-label={t('wiki.toolbar')} className="flex flex-wrap gap-1 border-b px-3 py-1.5">
              {SNIPPETS.map((s) => (
                <button key={s.key} type="button" onClick={() => apply(s)} className="min-h-7 cursor-pointer px-2 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                  {t(`wiki.tool_${s.key}`)}
                </button>
              ))}
              <span className="ml-auto self-center font-mono text-[0.6875rem] text-muted-foreground">Ctrl+S</span>
            </div>
            <Textarea
              ref={area}
              aria-label={t('knowledge.text')}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder={t('wiki.editorHint')}
              className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[0.8125rem] leading-relaxed shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="min-h-[320px] overflow-y-auto px-6 py-5">
            <div className="label-mono mb-3">{t('wiki.preview')}</div>
            {draft.text.trim() ? (
              <WikiMarkdown text={draft.text} resolve={resolve} missingHint={t('wiki.missingLink')} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('wiki.previewEmpty')}</p>
            )}
          </div>
        </div>
      )}
    </form>
  )
}

function FolderView({
  folder,
  notes,
  all,
  colorOf,
  onOpen,
  onNew,
  onGraph,
}: {
  folder: string
  notes: KnowledgeItem[]
  all: KnowledgeItem[]
  colorOf: (f: string) => string
  onOpen: (id: string) => void
  onNew: () => void
  onGraph: () => void
}) {
  const { t } = useTranslation()
  const recent = [...notes].sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at))
  const folders = new Set(all.map((i) => i.folder ?? '').filter(Boolean))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-2">
            <span className="label-mono">{folder ? t('wiki.folder') : t('wiki.home')}</span>
            <h2 className="text-3xl font-medium tracking-tight">{folder ? folder.split('/').pop() : t('knowledge.title')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{folder ? folder : t('knowledge.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onGraph}>
              <Network />
              {t('wiki.view_graph')}
            </Button>
            <Button onClick={onNew}>
              <FilePlus2 />
              {t('wiki.newNote')}
            </Button>
          </div>
        </div>
        {!folder && (
          <div className="grid grid-cols-3 border bg-card">
            {[
              [t('wiki.statNotes'), all.length],
              [t('wiki.statFolders'), folders.size],
              [t('wiki.statChars'), formatNumber(all.reduce((s, i) => s + (i.chars ?? 0), 0))],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex flex-col gap-1 border-r p-4 last:border-r-0">
                <span className="label-mono">{k}</span>
                <span className="text-2xl font-medium tabular-nums">{v}</span>
              </div>
            ))}
          </div>
        )}
        {recent.length ? (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {recent.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onOpen(n.id)} className="flex h-full w-full cursor-pointer flex-col gap-2 border bg-card p-4 text-left hover:border-foreground/30" style={{ boxShadow: `inset 3px 0 0 ${colorOf(n.folder ?? '')}` }}>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">{n.folder || t('wiki.root')}</span>
                  <span className="font-medium">{n.title}</span>
                  <span className="mt-auto font-mono text-[0.6875rem] text-muted-foreground">
                    {t('wiki.chars', { n: formatNumber(n.chars ?? 0) })} · {formatDate(n.updated_at ?? n.created_at, { timeStyle: undefined })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<BookOpen />} title={t('knowledge.empty')} hint={t('wiki.emptyHint')} />
        )}
      </div>
    </div>
  )
}
