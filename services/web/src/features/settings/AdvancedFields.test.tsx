import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
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
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.openai_compatible.max_output_tokens).toBe(48000))
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
})
