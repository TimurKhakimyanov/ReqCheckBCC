import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { SettingsPage } from './SettingsPage'

const options = (provider: string) =>
  Array.from(document.querySelectorAll(`#models-${provider} option`)).map((o) => (o as HTMLOptionElement).value)

describe('Provider card', () => {
  it('loads the live model list right after a key is pasted (debounced test with unsaved key)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-anthropic')
    expect(options('anthropic')).toEqual([])
    await user.type(within(card).getByLabelText('API-ключ'), 'sk-ant-valid-key-123')
    await waitFor(() => expect(options('anthropic')).toContain('claude-sonnet-4-5'), { timeout: 3000 })
    expect(within(card).getByRole('status')).toHaveTextContent('Подключение работает')
    // ключ ещё не сохранён
    expect(db.providers.anthropic.has_key).toBe(false)
  })

  it('shows a human-readable error with expandable details for a rejected key', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-openai')
    await user.type(within(card).getByLabelText('API-ключ'), 'bad-key-0000')
    await user.click(within(card).getByRole('button', { name: /Проверить подключение/ }))
    const alert = await within(card).findByRole('alert')
    expect(alert).toHaveTextContent('Провайдер не принял API-ключ')
    expect(alert).toHaveTextContent('Incorrect API key provided')
    expect(within(alert).getByText('Подробности')).toBeInTheDocument()
  })

  it('local model: models come from the base URL alone, key is optional', async () => {
    const user = userEvent.setup()
    db.providers.openai_compatible.base_url = null
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-openai_compatible')
    expect(within(card).getByText('Не настроен')).toBeInTheDocument()
    expect(within(card).getByLabelText('Ключ (необязательно)')).toBeInTheDocument()
    await user.type(within(card).getByLabelText('Адрес сервера (base URL)'), 'http://vllm.example.local:8000/v1')
    await waitFor(() => expect(options('openai_compatible')).toEqual(['local-model']), { timeout: 3000 })
    expect(within(card).getByLabelText('Модель по умолчанию')).toHaveValue('local-model')
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.openai_compatible.base_url).toBe('http://vllm.example.local:8000/v1'))
    expect(db.providers.openai_compatible.default_model).toBe('local-model')
    expect(db.providers.openai_compatible.has_key).toBe(false)
  })
})
