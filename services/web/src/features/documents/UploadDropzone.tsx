import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { DocumentItem } from '@/api/types'
import { Progress } from '@/components/ui/misc'
import { formatBytes } from '@/shared/format'
import { cn } from '@/shared/utils'

export const ACCEPTED_EXT = ['pdf', 'docx', 'md', 'txt']
export const DEFAULT_MAX_UPLOAD_MB = 25

export function validateFile(file: File, maxMb = DEFAULT_MAX_UPLOAD_MB): 'format' | 'size' | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ACCEPTED_EXT.includes(ext)) return 'format'
  if (file.size > maxMb * 1024 * 1024) return 'size'
  return null
}

/** Лимит загрузки из GET /health (limits.max_upload_mb), иначе 25 МБ. */
export function useMaxUploadMb() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 5 * 60_000, retry: false })
  return health.data?.limits?.max_upload_mb ?? DEFAULT_MAX_UPLOAD_MB
}

interface Item {
  name: string
  size: number
  pct: number
}

export function UploadDropzone({ onUploaded }: { onUploaded?: (doc: DocumentItem) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const maxMb = useMaxUploadMb()

  const uploadAll = async (files: File[]) => {
    for (const file of files) {
      const problem = validateFile(file, maxMb)
      if (problem) {
        toast.error(t(problem === 'format' ? 'upload.badFormat' : 'upload.tooLarge', { name: file.name, mb: maxMb }))
        continue
      }
      setItems((xs) => [...xs, { name: file.name, size: file.size, pct: 0 }])
      try {
        const doc = await api.uploadDocument(file, (pct) =>
          setItems((xs) => xs.map((x) => (x.name === file.name ? { ...x, pct } : x))),
        )
        toast.success(t('upload.done', { name: file.name }))
        void qc.invalidateQueries({ queryKey: ['documents'] })
        onUploaded?.(doc)
      } catch (e) {
        toast.error(t('upload.failed', { name: file.name, error: (e as Error).message }))
      } finally {
        setItems((xs) => xs.filter((x) => x.name !== file.name))
      }
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    void uploadAll(Array.from(e.dataTransfer.files))
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('upload.title')}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        data-testid="dropzone"
        className={cn(
          'bg-grid group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/15 bg-card px-6 py-10 text-center shadow-xs transition-colors outline-none hover:border-primary/60 focus-visible:ring-[3px] focus-visible:ring-ring/30',
          drag && 'border-primary bg-primary-tint',
        )}
      >
        <span className="mb-1 flex size-11 items-center justify-center rounded-xl bg-card text-muted-foreground shadow-card transition-colors group-hover:text-primary">
          <FileUp className="size-5" />
        </span>
        <p className="font-medium">{t('upload.title')}</p>
        <p className="text-sm text-muted-foreground">{t('upload.hint', { mb: maxMb })}</p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.md,.txt"
          data-testid="file-input"
          onChange={(e) => {
            void uploadAll(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {items.map((x) => (
            <li key={x.name} className="rounded-md border bg-card px-3 py-2 text-sm">
              <div className="mb-1.5 flex justify-between gap-2">
                <span className="truncate">{x.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatBytes(x.size)} · {x.pct}%
                </span>
              </div>
              <Progress value={x.pct} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
