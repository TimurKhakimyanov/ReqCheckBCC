import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import { onUnauthorized } from '@/api/client'
import { AppShell } from '@/components/layout/AppShell'
import { AuditPage } from '@/features/audit/AuditPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { DocumentPage } from '@/features/documents/DocumentPage'
import { DocumentsPage } from '@/features/documents/DocumentsPage'
import { KnowledgePage } from '@/features/knowledge/KnowledgePage'
import { NotFoundPage } from '@/features/misc/NotFoundPage'
import { RunPage } from '@/features/runs/RunPage'
import { SearchPage } from '@/features/search/SearchPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { UsagePage } from '@/features/usage/UsagePage'
import { ThemeProvider, useTheme } from '@/theme/theme'
import { ME_KEY, RequireAuth } from './auth'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
      mutations: { retry: 0 },
    },
  })
}

function ThemedToaster() {
  const { resolved } = useTheme()
  return <Toaster theme={resolved} richColors position="bottom-right" closeButton />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/documents" replace />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="documents/:id" element={<DocumentPage />} />
        <Route path="runs/:id" element={<RunPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export function App() {
  const [qc] = useState(createQueryClient)
  useEffect(() => {
    onUnauthorized(() => qc.setQueryData(ME_KEY, null))
    return () => onUnauthorized(null)
  }, [qc])
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
