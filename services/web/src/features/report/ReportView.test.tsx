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
    expect(mark.textContent).toBe(d001.locations[0].quote)
    // на полях — по одной пометке D-xxx на каждый дефект с найденной цитатой
    expect([...container.querySelectorAll('.rc-pin')].map((p) => p.textContent).sort()).toEqual(sampleReport.findings.map((f) => f.id).sort())
    // Markdown документа отрисован: таблицы — настоящие таблицы, «|» и «**» не видны текстом
    expect(within(screen.getByTestId('document-viewer')).getAllByRole('table').length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toHaveTextContent('Не готово к разработке')
    expect(screen.getByRole('status')).toHaveTextContent('Сначала закрыть: 3 критических дефекта, 2 блокирующих вопроса')
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

  it('summary tab shows key figures and per-criterion stats computed from the report', async () => {
    const user = userEvent.setup()
    renderReport()
    await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('tab', { name: 'Сводка и итог' }))
    const kpis = screen.getByLabelText('Ключевые показатели')
    expect(within(kpis).getByText('Требований')).toBeInTheDocument()
    expect(within(kpis).getByText(String(sampleReport.summary.findings_total))).toBeInTheDocument()
    // каждый критерий с дефектами — строка графика, сумма по строкам равна числу дефектов
    const table = screen.getByRole('table', { name: 'Дефекты по критериям' })
    const totals = within(table)
      .getAllByRole('row')
      .map((row) => Number(within(row).getAllByRole('cell').at(-1)!.textContent))
    expect(totals.reduce((a, b) => a + b, 0)).toBe(sampleReport.findings.length)
    // все 8 свойств набора перечислены
    expect(screen.getByText('Свойства набора')).toBeInTheDocument()
  })

  it('questions tab lists clarifying questions with options and linked findings', async () => {
    const user = userEvent.setup()
    renderReport()
    await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('tab', { name: /Вопросы/ }))
    const qs = sampleReport.questions ?? []
    expect(qs.length).toBeGreaterThan(0)
    for (const q of qs) expect(screen.getByText(q.question)).toBeInTheDocument()
    const opts = screen.getAllByRole('radiogroup', { name: 'Варианты ответа' })[0]
    expect(within(opts).getByText(qs[0].options![0])).toBeInTheDocument()
    expect(screen.getAllByText('Блокирующий').length).toBe(qs.filter((q) => q.priority === 'blocker').length)
    // выбор варианта засчитывается как ответ и переживает перерисовку (хранится в браузере)
    expect(screen.getByText(`Отвечено 0 из ${qs.length}`)).toBeInTheDocument()
    await user.click(within(opts).getByLabelText(new RegExp(qs[0].options![0])))
    expect(screen.getByText(`Отвечено 1 из ${qs.length}`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Без ответа/ }))
    expect(screen.queryByText(qs[0].question)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Все/ }))
    await user.click(screen.getAllByRole('button', { name: qs[0].finding_ids![0] })[0])
    expect(screen.getByRole('tab', { name: /Дефекты/ })).toHaveAttribute('data-state', 'active')
  })

  it('opens the section from ?tab= and shows counters in the section menu', async () => {
    renderReport('?tab=passport')
    expect(await screen.findByText(sampleReport.passport.document_sha256)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Паспорт' })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('tab', { name: /Дефекты/ })).toHaveTextContent(String(sampleReport.findings.length))
    const setPass = sampleReport.set_assessment.checks.filter((c) => c.verdict === 'pass').length
    expect(screen.getByRole('tab', { name: /Проверка набора/ })).toHaveTextContent(`${setPass}/${sampleReport.set_assessment.checks.length}`)
  })

  it('groups findings by document order and steps through them with the arrows', async () => {
    const user = userEvent.setup()
    renderReport()
    const list = await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('button', { name: 'По документу' }))
    await user.click(screen.getByRole('button', { name: 'Следующий дефект' }))
    // первая цитата в тексте — у D-001, следом в той же строке — D-003
    expect(list.querySelector('[data-finding="D-001"]')).toHaveAttribute('data-active', 'true')
    await user.click(screen.getByRole('button', { name: 'Следующий дефект' }))
    expect(list.querySelector('[data-finding="D-003"]')).toHaveAttribute('data-active', 'true')
    await user.click(screen.getByRole('button', { name: 'Предыдущий дефект' }))
    expect(list.querySelector('[data-finding="D-001"]')).toHaveAttribute('data-active', 'true')
    // повторный клик по заголовку выбранной карточки сворачивает её
    await user.click(within(list.querySelector('[data-finding="D-001"]') as HTMLElement).getByRole('button', { expanded: true }))
    expect(list.querySelector('[data-active="true"]')).toBeNull()
  })

  it('requirements section filters by kind and links to findings', async () => {
    const user = userEvent.setup()
    renderReport('?tab=requirements')
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(sampleReport.requirements.length + 1)
    await user.click(screen.getByRole('button', { name: /^API/ }))
    const api = sampleReport.requirements.filter((r) => r.kind === 'api')
    expect(within(table).getAllByRole('row')).toHaveLength(api.length + 1)
    await user.click(within(table).getByRole('button', { name: /Критический/ }))
    expect(screen.getByRole('tab', { name: /Дефекты/ })).toHaveAttribute('data-state', 'active')
    const list = await screen.findByTestId('findings-list')
    const expected = sampleReport.findings.filter((f) => f.requirement_ids?.includes(api[0].id))
    expect(list.querySelectorAll('[data-finding]')).toHaveLength(expected.length)
  })
})
