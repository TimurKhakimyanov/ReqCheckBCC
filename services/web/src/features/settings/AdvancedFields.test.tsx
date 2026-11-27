import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { db } from '@/mocks/data'
import { server } from '@/test/setup'
import { renderWithProviders } from '@/test/render'
import { parseJsonObject } from './advanced'
import { SettingsPage } from './SettingsPage'

describe('parseJsonObject', () => {
  it('accepts objects and empty input, rejects other JSON and garbage', () => {
    expect(parseJsonObject('')).toEqual({ value: null })
    expect(parseJsonObject(' {"a": {"b": false}} ').value).toEqual({ a: { b: false } })
    expect(parseJsonObject('[1, 2]').error).toBe('not_object')
    expect(parseJsonObject('true').error).toBe('not_object')
    expect(parseJsonObject('{a: 1}').error).toBe('invalid')
  })
})

describe('Advanced provider parameters', () => {
  it('applies the vLLM preset and saves extra_body, set-review override and max tokens', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-openai_compatible')
    await user.click(within(card).getByText('Расширенные'))
    await user.click(within(card).getByRole('button', { name: /vLLM: без рассуждений/ }))
    expect(within(card).getByLabelText('Макс. токенов ответа')).toHaveValue(48000)
    expect(within(card).getByLabelText('Таймаут запроса, с')).toHaveValue(900)
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.openai_compatible.max_output_tokens).toBe(48000))
    expect(db.providers.openai_compatible.timeout_s).toBe(900)
    expect(db.providers.openai_compatible.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(db.providers.openai_compatible.extra_body_set_review).toEqual({ chat_template_kwargs: { enable_thinking: true } })
  })

  it('blocks saving invalid JSON and explains why', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-openai_compatible')
    await user.click(within(card).getByText('Расширенные'))
    const field = within(card).getByLabelText('Доп. параметры запроса (JSON)')
    await user.click(field)
    await user.paste('{"chat_template_kwargs": ')
    expect(within(card).getByText(/Это не JSON/)).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(within(card).getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    await user.clear(field)
    await user.paste('[1]')
    expect(within(card).getByText(/Нужен JSON-объект/)).toBeInTheDocument()
    await user.clear(field)
    expect(within(card).getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  })

  it('validates the request timeout and sends unsaved extras with the connection test', async () => {
    const user = userEvent.setup()
    let testBody: Record<string, unknown> | null = null
    server.use(
      http.post('*/api/providers/:p/test', async ({ request }) => {
        testBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, latency_ms: 5, models: ['local-model'] })
      }),
    )
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-openai_compatible')
    await user.click(within(card).getByText('Расширенные'))
    const timeout = within(card).getByLabelText('Таймаут запроса, с')
    expect(timeout).toHaveAttribute('placeholder', '180')
    await user.type(timeout, '5')
    expect(within(card).getByText('Целое число от 10 до 3600')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Сохранить' })).toBeDisabled()
    await user.clear(timeout)
    await user.type(timeout, '600')
    await user.click(within(card).getByRole('button', { name: /Проверить подключение/ }))
    await waitFor(() => expect(testBody).toMatchObject({ timeout_s: 600, extra_body: null }))
  })
})
