import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RAW_400 } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { RunPage } from './RunPage'

describe('Failed run screen', () => {
  it('shows a short human message instead of the raw SDK error, raw text under Details', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RunPage />, { route: '/runs/run-failed', path: '/runs/:id' })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Провайдер отклонил запрос')
    expect(alert).toHaveTextContent("Unsupported parameter: 'max_tokens' is not supported with this model")
    // сырой текст спрятан в «Подробностях», не в заголовке
    expect(within(alert).getByText('Провайдер отклонил запрос').textContent).not.toContain('BadRequestError')
    const details = within(alert).getByText('Подробности').closest('details')!
    expect(details).not.toHaveAttribute('open')
    await user.click(within(alert).getByText('Подробности'))
    expect(details).toHaveAttribute('open')
    expect(details.querySelector('pre')!.textContent).toBe(RAW_400)
    // ни один этап не помечен как упавший: из истории стадия сбоя неизвестна
    expect(document.querySelector('[data-state="failed"]')).toBeNull()
  })
})
