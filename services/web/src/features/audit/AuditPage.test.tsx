import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ThemeToggle } from '@/components/layout/Preferences'
import { renderWithProviders } from '@/test/render'
import { AuditPage } from './AuditPage'

describe('Audit page', () => {
  it('runs tab: document → runs tree, agent tree with LLM calls and expandable entries', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AuditPage />, { route: '/audit?run=run-sample' })
    const tree = await screen.findByRole('tree', { name: 'Запуски агентов' })
    expect(within(tree).getAllByText('requirements.md').length).toBeGreaterThan(0)
    expect(within(tree).getByTestId('nav-run-run-sample')).toHaveAttribute('aria-selected', 'true')

    const agents = await screen.findByRole('tree', { name: 'Агенты прогона' })
    const set = within(agents).getByTestId('group-checking_set')
    expect(set).toHaveTextContent('Рецензенты набора')
    expect(set).toHaveTextContent('6 вызовов LLM')
    // группа с предупреждением раскрыта сразу
    expect(set).toHaveAttribute('aria-expanded', 'true')
    expect(within(set).getByText(/архитектор интеграций» не выполнен моделью/)).toBeInTheDocument()

    // раскрыть агента и запись с данными
    const parsing = within(agents).getByTestId('group-parsing')
    expect(parsing).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(parsing).getAllByRole('button')[0])
    expect(parsing).toHaveAttribute('aria-expanded', 'true')
    const line = within(parsing).getAllByTestId('log-line')[0]
    await user.click(within(line).getByRole('button'))
    expect(within(line).getByText('Данные записи')).toBeInTheDocument()

    // фильтр «Вызовы LLM» оставляет только агентов с вызовами модели
    await user.click(screen.getByRole('radio', { name: 'Вызовы LLM' }))
    await waitFor(() => expect(within(agents).queryByTestId('group-parsing')).toBeNull())
    expect(within(agents).getByTestId('group-segmenting')).toBeInTheDocument()
    expect(within(agents).getAllByTestId('log-line').every((l) => l.textContent?.includes('LLM'))).toBe(true)
  })

  it('failed run: failing agent is red and expanded with the traceback', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AuditPage />, { route: '/audit?run=run-failed' })
    const agents = await screen.findByRole('tree', { name: 'Агенты прогона' })
    const reqs = within(agents).getByTestId('group-checking_requirements')
    expect(reqs).toHaveAttribute('data-state', 'failed')
    expect(reqs).toHaveAttribute('aria-expanded', 'true')
    const err = within(reqs).getAllByTestId('log-line').find((l) => l.dataset.level === 'error')!
    await user.click(within(err).getByRole('button'))
    expect(within(err).getByText(/Traceback/)).toBeInTheDocument()
    expect(within(agents).getByTestId('group-checking_set')).toHaveAttribute('data-state', 'pending')
  })

  it('actions tab: filter by action, expand a row and jump to the run log', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AuditPage />, { route: '/audit?tab=actions' })
    const table = await screen.findByRole('table')
    expect(within(table).getByText('document.upload')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Действие' }), 'run.create')
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('document.upload')).toBeNull())
    await user.click(within(screen.getByRole('table')).getAllByText('run.create')[0])
    await user.click(await screen.findByRole('button', { name: /Журнал прогона/ }))
    expect(await screen.findByRole('tree', { name: 'Агенты прогона' })).toBeInTheDocument()
  })
})

describe('Theme toggle', () => {
  it('switches light ⇄ dark in one click without a menu', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ThemeToggle />)
    const btn = screen.getByTestId('theme-toggle')
    expect(document.documentElement).toHaveClass('dark') // тёмная по умолчанию
    expect(btn).toHaveAccessibleName('Светлая тема')
    await user.click(btn)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(btn).toHaveAccessibleName('Тёмная тема')
    expect(localStorage.getItem('reqcheck.theme')).toBe('light')
    await user.click(btn)
    expect(document.documentElement).toHaveClass('dark')
  })
})
