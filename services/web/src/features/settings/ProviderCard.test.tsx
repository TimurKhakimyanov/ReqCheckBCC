import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { SettingsPage } from './SettingsPage'

type User = ReturnType<typeof userEvent.setup>

/** Открывает выпадающий список моделей карточки и возвращает модели (без пункта «Другая модель…»). */
async function openModels(user: User, card: HTMLElement) {
  await user.click(within(card).getByRole('combobox'))
  const list = await screen.findByRole('listbox')
  return within(list)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
    .filter((t) => !/Другая модель|Использовать/.test(t))
}

describe('Provider card', () => {
  it('pasted key: badge says unsaved, full model list in a dropdown, missing default model is flagged', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-anthropic')
    expect(within(card).getByTestId('key-state')).toHaveTextContent('Ключ не задан')
    await user.type(within(card).getByLabelText('API-ключ'), 'sk-ant-valid-key-1234')
    expect(within(card).getByTestId('key-state')).toHaveTextContent('Ключ введён, не сохранён')

    // проверка вернула 404 по модели по умолчанию, но список моделей пришёл
    const alertTitle = await within(card).findByText('Модель «claude-opus-4-1» не найдена у провайдера', {}, { timeout: 3000 })
    expect(alertTitle).toBeInTheDocument()
    expect(within(card).getByText(/Модель «claude-opus-4-1» недоступна у провайдера — выберите из списка/)).toBeInTheDocument()
    expect(within(card).getByRole('combobox')).toHaveAttribute('aria-invalid', 'true')

    const models = await openModels(user, card)
    expect(models).toHaveLength(5)
    expect(models).toContain('claude-sonnet-4-5')
    await user.click(screen.getByRole('option', { name: /claude-sonnet-4-5/ }))
    expect(within(card).getByRole('combobox')).toHaveTextContent('claude-sonnet-4-5')
    expect(within(card).queryByText(/недоступна у провайдера/)).toBeNull()

    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.anthropic.default_model).toBe('claude-sonnet-4-5'))
    expect(await within(await screen.findByTestId('provider-anthropic')).findByTestId('key-state')).toHaveTextContent('Ключ задан …1234')
  })

  it('search filters the list and «Другая модель…» switches to manual input', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('provider-gemini')
    await waitFor(() => expect(within(card).getByText(/3 модели доступны/)).toBeInTheDocument())
    await user.click(within(card).getByRole('combobox'))
    await user.type(screen.getByRole('searchbox'), 'pro')
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'gemini-2.5-pro',
      'Использовать «pro»',
    ])
    await user.clear(screen.getByRole('searchbox'))
    await user.click(screen.getByRole('option', { name: /Другая модель/ }))
    const manual = within(card).getByLabelText('Модель по умолчанию')
    expect(manual.tagName).toBe('INPUT')
    await user.clear(manual)
    await user.type(manual, 'gemini-exp-1234')
    expect(manual).toHaveValue('gemini-exp-1234')
    expect(within(card).getByText(/недоступна у провайдера/)).toBeInTheDocument()
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
    expect(within(card).getByTestId('key-state')).toHaveTextContent('Не настроен')
    expect(within(card).getByLabelText('Ключ (необязательно)')).toBeInTheDocument()
    await user.type(within(card).getByLabelText('Адрес сервера (base URL)'), 'http://vllm.example.local:8000/v1')
    expect(within(card).getByTestId('key-state')).toHaveTextContent('Адрес изменён, не сохранён')
    await waitFor(() => expect(within(card).getByText(/Провайдер вернул 1 модель/)).toBeInTheDocument(), { timeout: 3000 })
    expect(await openModels(user, card)).toEqual(['local-model'])
    await user.keyboard('{Escape}')
    expect(within(card).getByRole('combobox')).toHaveTextContent('local-model')
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.openai_compatible.base_url).toBe('http://vllm.example.local:8000/v1'))
    expect(db.providers.openai_compatible.default_model).toBe('local-model')
    expect(db.providers.openai_compatible.has_key).toBe(false)
  })
})
