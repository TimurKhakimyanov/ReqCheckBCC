import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, FileUp, Plus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, Label, Textarea } from '@/components/ui/input'
import { EmptyState, ErrorNote, PageHeader, Skeleton, Spinner, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc'
import { formatDate } from '@/shared/format'

export function KnowledgePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const items = useQuery({
    queryKey: ['knowledge'],
    queryFn: api.knowledge,
    refetchInterval: (q) => (q.state.data?.some((k) => k.status === 'indexing') ? 2000 : false),
  })
  const done = () => qc.invalidateQueries({ queryKey: ['knowledge'] })
  const upload = useMutation({ mutationFn: api.uploadKnowledge, onSuccess: () => { toast.success(t('knowledge.added')); void done() }, onError: (e) => toast.error(e.message) })
  const addText = useMutation({
    mutationFn: () => api.addKnowledgeText(title.trim(), text.trim()),
    onSuccess: () => {
      toast.success(t('knowledge.added'))
      setAdding(false)
      setTitle('')
      setText('')
      void done()
    },
  })
  const del = useMutation({ mutationFn: api.deleteKnowledge, onSuccess: done, onError: (e) => toast.error(e.message) })

  return (
    <>
      <PageHeader
        title={t('knowledge.title')}
        description={t('knowledge.subtitle')}
        actions={
          <>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus />
              {t('knowledge.addText')}
            </Button>
            <Button onClick={() => file.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Spinner /> : <FileUp />}
              {t('knowledge.upload')}
            </Button>
            <input
              ref={file}
              type="file"
              hidden
              accept=".pdf,.docx,.md,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) upload.mutate(f)
                e.target.value = ''
              }}
            />
          </>
        }
      />
      {items.error && <ErrorNote error={items.error} />}
      <Card>
        {items.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : !items.data?.length ? (
          <EmptyState icon={<BookOpen />} title={t('knowledge.empty')} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('knowledge.name')}</TH>
                <TH>{t('knowledge.source')}</TH>
                <TH>{t('knowledge.chunks')}</TH>
                <TH>{t('knowledge.status')}</TH>
                <TH>{t('knowledge.added_at')}</TH>
                <TH className="w-0" />
              </TR>
            </THead>
            <TBody>
              {items.data.map((k) => (
                <TR key={k.id}>
                  <TD className="font-medium">{k.title}</TD>
                  <TD>
                    <Badge variant="outline">{t(`knowledge.src.${k.source}`)}</Badge>
                  </TD>
                  <TD className="tabular-nums">{k.chunks}</TD>
                  <TD>
                    <Badge variant={k.status === 'ready' ? 'success' : k.status === 'failed' ? 'destructive' : 'secondary'}>
                      {k.status === 'indexing' && <Spinner className="size-3" />}
                      {t(`knowledge.st.${k.status}`)}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDate(k.created_at)}</TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common.delete')}
                      disabled={k.source === 'builtin'}
                      title={k.source === 'builtin' ? t('knowledge.builtinHint') : t('common.delete')}
                      onClick={() => window.confirm(t('knowledge.confirmDelete', { name: k.title })) && del.mutate(k.id)}
                    >
                      <Trash2 />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('knowledge.addText')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="kb-title">{t('knowledge.name')}</Label>
              <Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kb-text">{t('knowledge.text')}</Label>
              <Textarea id="kb-text" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('knowledge.textHint')} />
            </div>
            {addText.error && <ErrorNote error={addText.error} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => addText.mutate()} disabled={!title.trim() || !text.trim() || addText.isPending}>
              {addText.isPending && <Spinner />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
