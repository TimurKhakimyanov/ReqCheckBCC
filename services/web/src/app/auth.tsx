import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api, ApiError } from '@/api/client'
import type { User } from '@/api/types'
import { Spinner } from '@/components/ui/misc'

export const ME_KEY = ['me'] as const

export function useMe() {
  return useQuery<User | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.me()
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useSetMe() {
  const qc = useQueryClient()
  return (u: User | null) => qc.setQueryData(ME_KEY, u)
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending, isError } = useMe()
  const loc = useLocation()
  if (isPending)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    )
  if (isError || !data) {
    const next = loc.pathname + loc.search
    return <Navigate to={`/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />
  }
  return <>{children}</>
}
