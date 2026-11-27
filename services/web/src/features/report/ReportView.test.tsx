import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db, sampleReport, withAnswers } from '@/mocks/data'
import { RunPage } from '@/features/runs/RunPage'
import { renderWithProviders } from '@/test/render'

const renderReport = (query = '') => renderWithProviders(<RunPage />, { route: `/runs/run-sample${query}`, path: '/runs/:id' })

describe('Report screen', () => {
  afterEach(() => vi.unstubAllGlobals())

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
    // выбранный ответ считается и сохраняется в браузере
    expect(screen.getByText(`Отвечено 0 из ${qs.length}`)).toBeInTheDocument()
    await user.click(within(opts).getAllByRole('radio')[0])
    expect(screen.getByText(`Отвечено 1 из ${qs.length}`)).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('reqcheck.answers.run-sample') ?? '{}')[qs[0].id]).toEqual({ choice: 0 })
    await user.click(screen.getAllByRole('button', { name: qs[0].finding_ids![0] })[0])
    expect(screen.getByRole('tab', { name: /Дефекты/ })).toHaveAttribute('data-state', 'active')
  })

  it('re-checks the document with the author answers as a new run', async () => {
    // после запуска открывается экран нового прогона с потоком событий — в jsdom EventSource нет
    vi.stubGlobal('EventSource', class { readyState = 0; onmessage = null; onerror = null; addEventListener() {} close() {} })
    const user = userEvent.setup()
    renderReport()
    await screen.findByTestId('findings-list')
    await user.click(screen.getByRole('tab', { name: /Вопросы/ }))
    const rerun = screen.getByRole('button', { name: 'Перепроверить с ответами' })
    expect(rerun).toBeDisabled()
    const qs = sampleReport.questions!
    await user.click(within(screen.getAllByRole('radiogroup', { name: 'Варианты ответа' })[0]).getAllByRole('radio')[1])
    await user.type(screen.getAllByPlaceholderText('Свой вариант ответа')[1], 'Только по рабочим дням')
    await user.click(rerun)
    // новый прогон того же документа той же моделью, с ответами {Q-…: текст}
    await waitFor(() => expect(db.runs[0].id).not.toBe('run-sample'))
    const sample = db.runs.find((r) => r.id === 'run-sample')!
    expect(db.runs[0]).toMatchObject({ document_id: sample.document_id, provider: sample.provider, model: sample.model })
    expect(db.runs[0].options.answers).toEqual({ [qs[0].id]: qs[0].options![1], [qs[1].id]: 'Только по рабочим дням' })
    // пакет и параллельность — из текущих настроек, а не из старого прогона
    expect(db.runs[0].options).not.toHaveProperty('concurrency')
    expect(db.runs[0].options).not.toHaveProperty('batch_size')
  })

  it('shows the author answer, new wording and closed findings of a report built with answers', async () => {
    const user = userEvent.setup()
    const q = sampleReport.questions![0]
    db.reports['run-sample'] = withAnswers(sampleReport, { [q.id]: q.options![0] })
    renderReport()
    const list = await screen.findByTestId('findings-list')
    const closed = q.finding_ids![0]
    expect(within(list.querySelector(`[data-finding="${closed}"]`) as HTMLElement).getByText(`Снят ответом на ${q.id}`)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Вопросы/ }))
    expect(screen.getByRole('status')).toHaveTextContent(`учтено 1 из ${sampleReport.questions!.length}`)
    const res = screen.getByRole('region', { name: 'Что изменил ответ' })
    expect(within(res).getByText(q.options![0])).toBeInTheDocument()
    expect(within(res).getByText('Новые формулировки')).toBeInTheDocument()
    expect(within(res).getByRole('button', { name: closed })).toBeInTheDocument()
    // ответ из отчёта — начальное значение черновика: его вариант уже выбран
    expect(within(screen.getAllByRole('radiogroup', { name: 'Варианты ответа' })[0]).getAllByRole('radio')[0]).toBeChecked()
  })

  it('groups findings by severity or document order and steps through them with ↑↓', async () => {
    const user = userEvent.setup()
    renderReport()
    const list = await screen.findByTestId('findings-list')
    // по серьёзности: сначала все критические
    const ids = () => [...list.querySelectorAll('[data-finding]')].map((el) => el.getAttribute('data-finding'))
    const bySev = ids()
    const crit = sampleReport.findings.filter((f) => f.severity === 'critical').map((f) => f.id)
    expect(bySev.slice(0, crit.length).sort()).toEqual([...crit].sort())
    await user.click(screen.getByRole('button', { name: 'По документу' }))
    expect(ids().sort()).toEqual([...bySev].sort())
    // ↓ выбирает первый дефект списка, ещё ↓ — следующий
    await user.click(screen.getByRole('button', { name: /Следующий дефект/ }))
    const order = ids()
    expect(list.querySelector(`[data-finding="${order[0]}"]`)).toHaveAttribute('data-active', 'true')
    await user.click(screen.getByRole('button', { name: /Следующий дефект/ }))
    expect(list.querySelector(`[data-finding="${order[1]}"]`)).toHaveAttribute('data-active', 'true')
  })
})
