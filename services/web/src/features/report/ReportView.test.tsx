import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db, sampleReport } from '@/mocks/data'
import { RunPage } from '@/features/runs/RunPage'
import { renderWithProviders } from '@/test/render'

const renderReport = (query = '') => renderWithProviders(<RunPage />, { route: `/runs/run-sample${query}`, path: '/runs/:id' })

describe('Report screen', () => {
  it('shows the document with highlighted quotes and the findings list', async () => {
    const { container } = renderReport()
    const list = await screen.findByTestId('findings-list')
    expect(within(list).getAllByText(/^D-\d{3}$/)).toHaveLength(sampleReport.findings.length)
    const marks = container.querySelectorAll('mark.rc-hl')
    expect(marks.length).toBeGreaterThan(0)
    // подсвечен ровно текст цитаты по смещениям
    const d001 = sampleReport.findings.find((f) => f.id === 'D-001')!
    const mark = container.querySelector('mark[data-loc~="D-001:0"]')!
    expect(mark.textContent?.replace(/^D-001/, '')).toBe(d001.locations[0].quote)
    expect(screen.getByText('Не готово к разработке')).toBeInTheDocument()
  })

  it('clicking a finding activates its highlights; clicking a highlight selects the finding', async () => {
    const user = userEvent.setup()
    const { container } = renderReport()
    const list = await screen.findByTestId('findings-list')
    const card = list.querySelector('[data-finding="D-002"]') as HTMLElement
    await user.click(card)
    expect(container.querySelector('mark[data-ids~="D-002"]')).toHaveAttribute('data-active', 'true')
    expect(within(card).getByText(sampleReport.findings.find((f) => f.id === 'D-002')!.explanation)).toBeInTheDocument()

    await user.click(container.querySelector('mark[data-ids~="D-005"]') as HTMLElement)
    const card5 = list.querySelector('[data-finding="D-005"]') as HTMLElement
    expect(card5).toHaveAttribute('data-active', 'true')
    expect(container.querySelector('mark[data-ids~="D-002"]')).toHaveAttribute('data-active', 'false')
  })

  it('filters by severity and review status', async () => {
    const user = userEvent.setup()
    const { container } = renderReport()
    const list = await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('button', { name: /Критический/ }))
    const critical = sampleReport.findings.filter((f) => f.severity === 'critical')
    expect(list.querySelectorAll('[data-finding]')).toHaveLength(critical.length)
    // подсветка тоже фильтруется
    container.querySelectorAll('mark.rc-hl').forEach((m) => expect(m).toHaveAttribute('data-severity', 'critical'))

    await user.click(screen.getByRole('button', { name: 'Сбросить' }))
    await user.selectOptions(screen.getByLabelText('Статус'), 'accepted')
    await waitFor(() => expect(list.querySelectorAll('[data-finding]')).toHaveLength(1))
    expect(list.querySelector('[data-finding="D-003"]')).not.toBeNull()
  })

  it('marks a finding as false positive with a comment', async () => {
    const user = userEvent.setup()
    renderReport('?finding=D-004')
    const list = await screen.findByTestId('findings-list')
    const card = list.querySelector('[data-finding="D-004"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: /Ложное срабатывание/ }))
    await waitFor(() => expect(db.reviews['run-sample']['D-004']?.status).toBe('false_positive'))
    await user.click(within(card).getByText('Добавить комментарий'))
    await user.type(within(card).getByPlaceholderText('Комментарий для команды'), 'Так и задумано')
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(db.reviews['run-sample']['D-004']?.comment).toBe('Так и задумано'))
  })

  it('renders the matrix, summary and passport tabs', async () => {
    const user = userEvent.setup()
    renderReport()
    await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('tab', { name: 'Матрица' }))
    for (const r of sampleReport.requirements) expect(screen.getByRole('button', { name: r.id })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Сводка и итог' }))
    expect(screen.getByText('Что исправить в первую очередь')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Паспорт' }))
    expect(screen.getByText(sampleReport.passport.document_sha256)).toBeInTheDocument()
  })
})
