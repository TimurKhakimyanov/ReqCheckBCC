import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { api } from '@/api/client'
import { db } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { SettingsPage } from './SettingsPage'

const open = () => renderWithProviders(<SettingsPage />, { route: '/settings?tab=params', path: '/settings' })

describe('AI parameters tab', () => {
  it('applies the free Gemini preset and saves via PUT /settings', async () => {
    const user = userEvent.setup()
    open()
    await screen.findByTestId('params-form')
    expect(screen.getByLabelText('Пауза между вызовами')).toHaveValue(0)
    expect(screen.getByText(/ошибки 429/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Бесплатный Gemini' }))
    expect(screen.getByLabelText('Пауза между вызовами')).toHaveValue(6)
    expect(screen.getByLabelText('Параллельных запросов')).toHaveValue(1)
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.settings.min_interval_s).toBe(6))
    expect(db.settings.max_attempts).toBe(8)
  })

  it('shows per-field 422 errors from the server', async () => {
    const user = userEvent.setup()
    open()
    const field = await screen.findByLabelText('Параллельных запросов')
    await user.clear(field)
    await user.type(field, '99')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    // своя проверка диапазона — без похода на сервер
    expect(await screen.findByText('Допустимо от 1 до 16')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(db.settings.concurrency).toBe(1)
    // сервер тоже проверяет: 422 с errors раскладывается по полям
    await expect(api.updateSettings({ concurrency: 99 })).rejects.toMatchObject({ status: 422, errors: [{ loc: ['body', 'concurrency'] }] })
  })

  it('sets a masked embeddings key and warns about reindexing', async () => {
    const user = userEvent.setup()
    open()
    await screen.findByTestId('params-form')
    await user.selectOptions(screen.getByLabelText('Провайдер эмбеддингов'), 'gemini')
    expect(screen.getByLabelText('Модель эмбеддингов')).toHaveValue('gemini-embedding-001')
    expect(screen.getByRole('note')).toHaveTextContent('переиндексированы')
    await user.type(screen.getByLabelText(/Ключ для эмбеддингов/), 'AIza-embed-9876')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.settings.embeddings.has_key).toBe(true))
    const s = await api.settings()
    expect(s.embeddings).toEqual({ provider: 'gemini', model: 'gemini-embedding-001', has_key: true, key_hint: '…9876' })
    expect(JSON.stringify(s)).not.toContain('AIza-embed-9876')
  })

  it('runs without explicit provider use the defaults from settings', async () => {
    db.settings.default_provider = 'openai_compatible'
    db.settings.default_model = 'local-model'
    const run = await api.createRun({ document_id: 'doc-sample' })
    expect(run.provider).toBe('openai_compatible')
    expect(run.model).toBe('local-model')
  })
})
