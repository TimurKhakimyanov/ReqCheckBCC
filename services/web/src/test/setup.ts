import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import i18n from '@/i18n'
import { resetDb, setSession } from '@/mocks/data'
import { handlers } from '@/mocks/handlers'

export const server = setupServer(...handlers)

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' })
  // fetch в Node не принимает относительные URL — достраиваем origin страницы jsdom
  const patched = globalThis.fetch
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    patched(typeof input === 'string' && input.startsWith('/') ? new URL(input, location.origin).href : input, init)
  await i18n.changeLanguage('ru')
  Element.prototype.scrollIntoView = vi.fn()
  // Radix Popover (floating-ui) ждёт ResizeObserver, которого нет в jsdom
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  resetDb()
  setSession(true)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
})

afterAll(() => server.close())
