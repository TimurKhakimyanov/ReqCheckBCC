// Диалоги папок вики: новая папка, переименование/перенос, удаление (содержимое уходит в родительскую папку).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'

export type FolderAction = { kind: 'new'; parent: string } | { kind: 'move'; path: string } | { kind: 'delete'; path: string; total: number }

export const parentOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')
export const baseName = (f: string) => f.split('/').pop() ?? f
export const joinPath = (parent: string, name: string) => [parent, name].map((p) => p.trim()).filter(Boolean).join('/')
export const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/')

export function FolderDialog({
  action,
  folders,
  onClose,
  onDone,
}: {
  action: FolderAction | null
  folders: string[]
  onClose: () => void
  /** Итоговый путь папки после действия (для удаления — родительская папка) */
  onDone: (path: string) => void
}) {
  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      {action && (
        <DialogContent>
          <Body key={JSON.stringify(action)} action={action} folders={folders} onClose={onClose} onDone={onDone} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function Body({ action, folders, onClose, onDone }: { action: FolderAction; folders: string[]; onClose: () => void; onDone: (path: string) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const source = action.kind === 'new' ? '' : action.path
  const [name, setName] = useState(action.kind === 'move' ? baseName(action.path) : '')
  const [parent, setParent] = useState(action.kind === 'new' ? action.parent : parentOf(source))
  const target = joinPath(parent, name.replace(/\//g, ' '))
  const run = useMutation({
    mutationFn: async () => {
      if (action.kind === 'new') return (await api.createFolder(target)).path
      if (action.kind === 'move') return (await api.moveFolder(action.path, target)).path
      return (await api.deleteFolder(action.path)).path
    },
    onSuccess: (path) => {
      toast.success(t(`wiki.folderDone_${action.kind}`))
      void qc.invalidateQueries({ queryKey: ['knowledge'] })
      onDone(path)
    },
    onError: (e) => toast.error(e.message),
  })
  // переносить можно в любую папку, кроме самой себя и вложенных в неё
  const parents = folders.filter((f) => !source || !within(f, source))
  const invalid = action.kind !== 'delete' && (!name.trim() || (action.kind === 'move' && target === source))

  if (action.kind === 'delete')
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('wiki.folderDelete')}</DialogTitle>
          <DialogDescription>
            {t('wiki.folderDeleteHint', { name: action.path, parent: parentOf(action.path) || t('wiki.home'), count: action.total })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending && <Spinner />}
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </>
    )

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!invalid) run.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>{action.kind === 'new' ? t('wiki.folderNew') : t('wiki.folderMove')}</DialogTitle>
        <DialogDescription>{action.kind === 'new' ? t('wiki.folderNewHint') : t('wiki.folderMoveHint')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="folder-name" className="label-mono">
          {t('wiki.folderName')}
        </Label>
        <Input id="folder-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="folder-parent" className="label-mono">
          {t('wiki.folderParent')}
        </Label>
        <select
          id="folder-parent"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          className="h-9 border border-input bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{t('wiki.home')}</option>
          {parents.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {t('wiki.folderResult')}: {target || '—'}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={invalid || run.isPending}>
          {run.isPending && <Spinner />}
          {action.kind === 'new' ? t('wiki.create') : t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
