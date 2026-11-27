import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'
import { installInPageMocks } from './inPage'

/** Моки через Service Worker (видны во вкладке Network); если SW недоступен — те же обработчики в странице. */
export async function startMocks() {
  try {
    if (!('serviceWorker' in navigator)) throw new Error('Service Worker API is not available')
    const worker = setupWorker(...handlers)
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true, serviceWorker: { url: '/mockServiceWorker.js' } })
  } catch (e) {
    console.warn('[mocks] Service Worker unavailable, using in-page mocks:', e)
    installInPageMocks()
  }
}
