import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { addDays, todayIso } from '@/shared/dates'
import { renderWithProviders } from '@/test/render'
import { UsagePage } from './UsagePage'

const bars = () => within(screen.getByRole('group', { name: 'По дням' })).getAllByRole('button')

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Период/ }))
  return screen.findByRole('dialog', { name: 'Выбор периода' })
}

describe('UsagePage', () => {
  it('shows KPIs, a bar per day and the provider table for the last 14 days', async () => {
    renderWithProviders(<UsagePage />)
    expect(await screen.findByRole('heading', { name: 'Стоимость' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '14 дн' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Период/ })).toHaveTextContent('14 дней')
    expect(bars()).toHaveLength(14)
    expect(screen.getByRole('table')).toHaveTextContent('Google Gemini')
  })

  it('applies a preset from the calendar', async () => {
    const user = userEvent.setup()
    renderWithProviders(<UsagePage />)
    const dialog = await openPicker(user)
    await user.click(within(dialog).getByRole('button', { name: 'Последние 7 дней' }))
    expect(within(dialog).getByRole('button', { name: 'Последние 7 дней' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(dialog).getByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: '7 дн' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(bars()).toHaveLength(7))
  })

  it('selects a range by two clicks, blocks future days and validates typed dates', async () => {
    const user = userEvent.setup()
    renderWithProviders(<UsagePage />)
    const dialog = await openPicker(user)
    const today = todayIso()
    const day = (iso: string) => dialog.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)

    await user.click(day(addDays(today, -3))!)
    expect(within(dialog).getByText('Выберите конечную дату')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Применить' })).toBeDisabled()
    await user.click(day(today)!)
    expect(within(dialog).getByText('4 дня')).toBeInTheDocument()
    const tomorrow = day(addDays(today, 1))
    if (tomorrow) expect(tomorrow).toBeDisabled()

    const from = within(dialog).getByLabelText('С')
    await user.clear(from)
    await user.type(from, '31.02.2026{Enter}')
    expect(within(dialog).getByText('Дата в формате дд.мм.гггг, не позже сегодня')).toBeInTheDocument()
    expect(from).toHaveAttribute('aria-invalid', 'true')
  })

  it('sorts the provider table by a column', async () => {
    const user = userEvent.setup()
    renderWithProviders(<UsagePage />)
    const cost = await screen.findByRole('columnheader', { name: /Стоимость/ })
    expect(cost).toHaveAttribute('aria-sort', 'descending')
    await user.click(within(cost).getByRole('button'))
    expect(cost).toHaveAttribute('aria-sort', 'ascending')
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Локальная модель')
  })
})
