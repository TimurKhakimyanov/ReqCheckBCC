import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { SettingsPage } from './SettingsPage'

type User = ReturnType<typeof userEvent.setup>

/** Открывает выпадающий список моделей и возвращает модели (без пункта «Другая модель…»). */
async function openModels(user: User) {
  await user.click(screen.getByRole('combobox'))
  const list = await screen.findByRole('listbox')
  return within(list)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
    .filter((t) => !/Другая модель|Использовать/.test(t))
}

async function openWizard(user: User) {
  await user.click((await screen.findAllByRole('button', { name: /Добавить провайдера/ }))[0])
  return screen.findByRole('dialog')
}

describe('Providers tab', () => {
  it('shows only connected providers and an add button', async () => {
    renderWithProviders(<SettingsPage />)
    expect(await screen.findByTestId('provider-gemini')).toBeInTheDocument()
    expect(screen.getByTestId('provider-openai_compatible')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-anthropic')).toBeNull()
    expect(within(screen.getByTestId('provider-gemini')).getByTestId('key-state')).toHaveTextContent('Ключ задан …a1b2')
    expect(screen.getByText('Подключено 2 провайдера из 4')).toBeInTheDocument()
  })

  it('empty state with an animated illustration when nothing is connected', async () => {
    db.providers.gemini.has_key = false
    db.providers.openai_compatible.base_url = null
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const empty = await screen.findByTestId('providers-empty')
    expect(within(empty).getByText('Пока ни одного провайдера')).toBeInTheDocument()
    expect(empty.querySelector('svg .rc-eyes')).not.toBeNull()
    const dialog = await openWizard(user)
    expect(within(dialog).getByText('Кого подключаем?')).toBeInTheDocument()
  })
})

describe('Provider wizard', () => {
  it('walks provider → account → model → params → review and saves', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const dialog = await openWizard(user)
    expect(within(dialog).getByRole('list', { name: 'Шаг 1 из 5' })).toBeInTheDocument()
    await user.click(within(dialog).getByTestId('pick-anthropic'))

    // шаг 2: ключ обязателен, проверка запускается сама
    const next = () => within(dialog).getByRole('button', { name: /Далее/ })
    expect(next()).toBeDisabled()
    await user.type(within(dialog).getByLabelText('API-ключ'), 'sk-ant-valid-key-1234')
    expect(next()).toBeEnabled()
    // проверка вернула 404 по модели по умолчанию, но список моделей пришёл
    expect(await within(dialog).findByText('Модель «claude-opus-4-1» не найдена у провайдера', {}, { timeout: 3000 })).toBeInTheDocument()
    await user.click(next())

    // шаг 3: модель из живого списка
    expect(within(dialog).getByText('Модель по умолчанию', { selector: 'h3' })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox')).toHaveAttribute('aria-invalid', 'true')
    const models = await openModels(user)
    expect(models).toHaveLength(5)
    await user.click(screen.getByRole('option', { name: /claude-sonnet-4-5/ }))
    expect(within(dialog).queryByText(/недоступна у провайдера/)).toBeNull()
    await user.click(next())

    // шаг 4: параметры можно пропустить
    expect(within(dialog).getByText('Параметры запросов')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Пропустить' }))

    // шаг 5: сводка и сохранение
    expect(within(dialog).getByText('новый ключ …1234')).toBeInTheDocument()
    expect(within(dialog).getByText('claude-sonnet-4-5')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.anthropic.default_model).toBe('claude-sonnet-4-5'))
    expect(db.providers.anthropic.has_key).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByTestId('provider-anthropic')).toBeInTheDocument()
  })

  it('rejected key: human-readable error with details on the account step', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const dialog = await openWizard(user)
    await user.click(within(dialog).getByTestId('pick-openai'))
    await user.type(within(dialog).getByLabelText('API-ключ'), 'bad-key-0000')
    await user.click(within(dialog).getByRole('button', { name: /Проверить подключение/ }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Провайдер не принял API-ключ')
    expect(alert).toHaveTextContent('Incorrect API key provided')
  })

  it('local model: base URL alone is enough, models come from the server', async () => {
    db.providers.openai_compatible.base_url = null
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const dialog = await openWizard(user)
    await user.click(within(dialog).getByTestId('pick-openai_compatible'))
    expect(within(dialog).getByLabelText('Ключ (необязательно)')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Адрес сервера (base URL)'), 'http://vllm.example.local:8000/v1')
    expect(await within(dialog).findByText(/Подключение работает, ответ за 412 мс/, {}, { timeout: 3000 })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Далее/ }))
    expect(await openModels(user)).toEqual(['local-model'])
    await user.keyboard('{Escape}')
    await user.click(within(dialog).getByRole('button', { name: /Далее/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Пропустить' }))
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.providers.openai_compatible.base_url).toBe('http://vllm.example.local:8000/v1'))
    expect(db.providers.openai_compatible.default_model).toBe('local-model')
    expect(db.providers.openai_compatible.has_key).toBe(false)
  })

  it('edit opens on the account step with the key kept; disconnect removes the key', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    const tile = await screen.findByTestId('provider-gemini')
    await user.click(within(tile).getByRole('button', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Изменить: Google Gemini')).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'Шаг 2 из 5' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Далее/ })).toBeEnabled() // ключ уже сохранён
    await user.keyboard('{Escape}')

    const confirm = window.confirm
    window.confirm = () => true
    try {
      await user.click(within(tile).getByRole('button', { name: 'Отключить провайдера' }))
      await waitFor(() => expect(db.providers.gemini.has_key).toBe(false))
      await waitFor(() => expect(screen.queryByTestId('provider-gemini')).toBeNull())
    } finally {
      window.confirm = confirm
    }
  })
})
