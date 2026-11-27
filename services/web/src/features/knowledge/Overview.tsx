// Обзор вики или папки: сводные цифры, страницы по папкам, недавние правки, самые связанные страницы,
// вложенные папки и карточки страниц.
import { BookOpen, FilePlus2, FileUp, Folder, FolderInput, FolderPlus, Network, Trash2 } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeGraph, KnowledgeItem } from '@/api/types'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/misc'
import { formatDate, formatNumber, formatRelative } from '@/shared/format'
import { baseName, within } from './FolderDialog'

const edited = (i: KnowledgeItem) => Date.parse(i.updated_at ?? i.created_at)

export function Overview({
  folder,
  all,
  folders,
  graph,
  colorOf,
  onOpen,
  onFolder,
  onNew,
  onUpload,
  onGraph,
  onNewFolder,
  onMoveFolder,
  onDeleteFolder,
}: {
  folder: string
  all: KnowledgeItem[]
  folders: string[]
  graph?: KnowledgeGraph
  colorOf: (f: string) => string
  onOpen: (id: string) => void
  onFolder: (f: string) => void
  onNew: () => void
  onUpload: () => void
  onGraph: () => void
  onNewFolder: () => void
  onMoveFolder: () => void
  onDeleteFolder: () => void
}) {
  const { t } = useTranslation()
  const notes = useMemo(() => (folder ? all.filter((i) => within(i.folder ?? '', folder)) : all), [all, folder])
  const recent = useMemo(() => [...notes].sort((a, b) => edited(b) - edited(a)), [notes])
  const children = useMemo(() => {
    const depth = folder ? folder.split('/').length + 1 : 1
    return folders.filter((f) => f.split('/').length === depth && (!folder || f.startsWith(folder + '/')))
  }, [folders, folder])

  // страницы по вложенным папкам (для корня — по верхним папкам и «без папки»)
  const bars = useMemo(() => {
    const rows = children.map((f) => ({ key: f, label: baseName(f), count: all.filter((i) => within(i.folder ?? '', f)).length }))
    const direct = notes.filter((i) => (i.folder ?? '') === folder).length
    if (direct) rows.push({ key: '', label: folder ? t('wiki.directly') : t('wiki.root'), count: direct })
    return rows.sort((a, b) => b.count - a.count)
  }, [children, all, notes, folder, t])
  const maxBar = Math.max(1, ...bars.map((b) => b.count))

  // самые связанные страницы: ссылки [[…]] в обе стороны
  const ids = useMemo(() => new Set(notes.map((n) => n.id)), [notes])
  const { hubs, linkCount } = useMemo(() => {
    const deg = new Map<string, number>()
    let linkCount = 0
    graph?.edges.forEach((e) => {
      if (e.kind !== 'link' || !(ids.has(e.source) || ids.has(e.target))) return
      linkCount++
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
    })
    const hubs = [...deg.entries()]
      .filter(([id]) => ids.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => ({ note: notes.find((x) => x.id === id)!, n }))
    return { hubs, linkCount }
  }, [graph, ids, notes])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-2">
            <span className="label-mono">{folder ? t('wiki.folder') : t('wiki.home')}</span>
            <h2 className="text-3xl font-medium tracking-tight">{folder ? baseName(folder) : t('knowledge.title')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{folder ? folder : t('knowledge.subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onGraph}>
              <Network />
              {t('wiki.view_graph')}
            </Button>
            <Button variant="outline" size="sm" onClick={onNewFolder}>
              <FolderPlus />
              {folder ? t('wiki.subfolder') : t('wiki.newFolder')}
            </Button>
            {folder && (
              <>
                <Button variant="outline" size="sm" onClick={onMoveFolder}>
                  <FolderInput />
                  {t('wiki.folderMove')}
                </Button>
                <Button variant="outline" size="sm" onClick={onDeleteFolder} aria-label={t('wiki.folderDelete')}>
                  <Trash2 />
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={onUpload}>
              <FileUp />
              {t('wiki.upload')}
            </Button>
            <Button size="sm" onClick={onNew}>
              <FilePlus2 />
              {t('wiki.newNote')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 border bg-card sm:grid-cols-4">
          {[
            [t('wiki.statNotes'), notes.length],
            [t('wiki.statFolders'), folder ? folders.filter((f) => f.startsWith(folder + '/')).length : folders.length],
            [t('wiki.statLinks'), linkCount],
            [t('wiki.statChars'), formatNumber(notes.reduce((s, i) => s + (i.chars ?? 0), 0))],
          ].map(([k, v]) => (
            <div key={String(k)} className="flex flex-col gap-1 border-r border-b p-4 last:border-r-0 sm:border-b-0">
              <span className="label-mono">{k}</span>
              <span className="text-2xl font-medium tabular-nums">{v}</span>
            </div>
          ))}
        </div>

        {notes.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title={t('wiki.byFolder')}>
              {bars.length ? (
                <ul className="flex flex-col gap-2" aria-label={t('wiki.byFolder')}>
                  {bars.map((b) => (
                    <li key={b.key || '.'}>
                      <button
                        type="button"
                        disabled={!b.key}
                        onClick={() => b.key && onFolder(b.key)}
                        className="flex w-full cursor-pointer flex-col gap-1 text-left text-sm disabled:cursor-default"
                      >
                        <span className="flex justify-between gap-2">
                          <span className="min-w-0 truncate">{b.label}</span>
                          <span className="font-mono text-xs text-muted-foreground tabular-nums">{b.count}</span>
                        </span>
                        <span className="h-1.5 bg-muted">
                          <span className="block h-full" style={{ width: `${(b.count / maxBar) * 100}%`, background: colorOf(b.key || folder) }} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t('wiki.noSubfolders')}</p>
              )}
            </Panel>
            <Panel title={t('wiki.recent')}>
              <ul className="flex flex-col gap-1.5" aria-label={t('wiki.recent')}>
                {recent.slice(0, 6).map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => onOpen(n.id)} className="flex w-full cursor-pointer items-baseline justify-between gap-2 text-left text-sm hover:text-accent-2">
                      <span className="min-w-0 truncate">{n.title}</span>
                      <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground" title={formatDate(n.updated_at ?? n.created_at)}>
                        {formatRelative(n.updated_at ?? n.created_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t('wiki.hubs')}>
              {hubs.length ? (
                <ul className="flex flex-col gap-1.5" aria-label={t('wiki.hubs')}>
                  {hubs.map(({ note, n }) => (
                    <li key={note.id}>
                      <button type="button" onClick={() => onOpen(note.id)} className="flex w-full cursor-pointer items-baseline justify-between gap-2 text-left text-sm hover:text-accent-2">
                        <span className="min-w-0 truncate">{note.title}</span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{t('wiki.linksN', { n })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t('wiki.noLinksYet')}</p>
              )}
            </Panel>
          </div>
        )}

        {children.length > 0 && (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label={t('wiki.subfolders')}>
            {children.map((f) => (
              <li key={f}>
                <button type="button" onClick={() => onFolder(f)} className="flex w-full cursor-pointer items-center gap-2.5 border bg-card px-3 py-2.5 text-left text-sm hover:border-foreground/30">
                  <Folder className="size-4 shrink-0" style={{ color: colorOf(f) }} />
                  <span className="min-w-0 flex-1 truncate">{baseName(f)}</span>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">{all.filter((i) => within(i.folder ?? '', f)).length}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {recent.length ? (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {recent.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpen(n.id)}
                  className="flex h-full w-full cursor-pointer flex-col gap-2 border bg-card p-4 text-left hover:border-foreground/30"
                  style={{ boxShadow: `inset 3px 0 0 ${colorOf(n.folder ?? '')}` }}
                >
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
          <EmptyState icon={<BookOpen />} title={folder ? t('wiki.folderEmpty') : t('knowledge.empty')} hint={t('wiki.emptyHint')} />
        )}
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 border bg-card p-4">
      <h3 className="label-mono">{title}</h3>
      {children}
    </section>
  )
}
