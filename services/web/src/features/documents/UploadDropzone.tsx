import { useQuery, useQueryClient } from '@tanstack/react-query'
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
    <div className="flex h-full flex-col">
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
          'group flex h-full min-h-[340px] cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-input bg-card/60 px-6 py-8 text-center transition-colors outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring',
          drag && 'border-primary bg-primary-tint',
        )}
      >
        <DropIllustration />
        <p className="text-lg font-medium tracking-tight">{t('upload.title')}</p>
        <p className="font-mono text-xs text-muted-foreground">{t('upload.hint', { mb: maxMb })}</p>
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
            <li key={x.name} className="rounded-2xl bg-card shadow-card px-3 py-2 text-sm">
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

/** Изометрическая стопка документов: на неё падает куб-файл. Только декор. */
function DropIllustration() {
  return (
    <svg viewBox="0 0 240 200" className="h-auto w-56 overflow-visible" aria-hidden>
      <polygon points="10,135 120,190 120,198 10,143" style={{ fill: 'var(--scene-face-r)', stroke: 'var(--scene-edge)' }} />
      <polygon points="120,190 230,135 230,143 120,198" style={{ fill: 'var(--scene-face-r)', stroke: 'var(--scene-edge)' }} />
      <polygon points="120,80 230,135 120,190 10,135" style={{ fill: 'var(--scene-pad)', stroke: 'var(--scene-edge)' }} />
      <polygon points="10,110 120,165 120,171 10,116" style={{ fill: 'var(--scene-face-l)', stroke: 'var(--teal)' }} />
      <polygon points="120,165 230,110 230,116 120,171" style={{ fill: 'var(--scene-face-l)', stroke: 'var(--teal)' }} />
      <polygon points="120,55 230,110 120,165 10,110" style={{ fill: 'var(--scene-pad)', stroke: 'var(--teal)' }} />
      <line x1="156.7" y1="73.3" x2="46.7" y2="128.3" style={{ stroke: 'var(--grid-line)' }} />
      <line x1="83.3" y1="73.3" x2="193.3" y2="128.3" style={{ stroke: 'var(--grid-line)' }} />
      <g className="rc-pulse">
        <polygon points="120,95 160,115 120,135 80,115" fill="none" style={{ stroke: 'var(--primary)' }} />
      </g>
      <g className="rc-drop-cube">
        <polygon points="95,62 120,74.5 120,112 95,99.5" style={{ fill: 'var(--scene-face-l)', stroke: 'var(--primary)' }} />
        <polygon points="120,74.5 145,62 145,99.5 120,112" style={{ fill: 'var(--scene-face-r)', stroke: 'var(--primary)' }} />
        <polygon points="120,49.5 145,62 120,74.5 95,62" stroke="#F49A5A" style={{ fill: 'var(--primary)' }} />
      </g>
    </svg>
  )
}
