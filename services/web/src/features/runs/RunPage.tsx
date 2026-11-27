import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { api } from '@/api/client'
import { ErrorNote, Skeleton } from '@/components/ui/misc'
import { ReportView } from '@/features/report/ReportView'
import { RunProgress } from './RunProgress'

/** /runs/:id — прогресс, пока прогон идёт или упал; отчёт, когда готов. */
export function RunPage() {
  const { id = '' } = useParams()
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.run(id) })
  if (run.error)
    return (
      <div className="p-6">
        <ErrorNote error={run.error} />
      </div>
    )
  if (!run.data)
    return (
      <div className="grid gap-3 p-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-64" />
      </div>
    )
  return run.data.status === 'done' ? <ReportView run={run.data} /> : <RunProgress key={run.data.id} run={run.data} />
}
