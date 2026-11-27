import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test/render'
import { AgentsPage } from './AgentsPage'
import { AGENTS, inputsOf, outputsOf } from './model'

const open = (route = '/agents') => renderWithProviders(<AgentsPage />, { route, path: '/agents' })

describe('Agents page', () => {
  it('links agents both ways: every input is a known agent and sees this agent as an output', () => {
    const ids = new Set(AGENTS.map((a) => a.id))
    AGENTS.forEach((a) => inputsOf(a).forEach((src) => {
      expect(ids.has(src)).toBe(true)
      expect(outputsOf(src)).toContain(a.id)
    }))
    expect(outputsOf('verifier')).toEqual(['merger'])
  })

  it('shows the pipeline and details of the picked agent', async () => {
    const user = userEvent.setup()
    open()
    expect(screen.getByRole('heading', { level: 1, name: 'Агенты' })).toBeInTheDocument()
    expect(screen.getByText('Выберите агента на схеме')).toBeInTheDocument()

    const scheme = screen.getByRole('list', { name: 'Схема прогона' })
    await user.click(within(scheme).getByRole('button', { name: /Верификатор/ }))
    const details = screen.getByRole('article')
    expect(within(details).getByRole('heading', { name: 'Верификатор' })).toBeInTheDocument()
    expect(within(details).getByText(/пытается опровергнуть каждый дефект/)).toBeInTheDocument()
    // связи: получает от проверки цитат и базы знаний, передаёт слиянию дублей
    expect(within(details).getByRole('button', { name: 'Проверка цитат' })).toBeInTheDocument()
    expect(within(details).getByRole('button', { name: 'База знаний' })).toBeInTheDocument()
    await user.click(within(details).getByRole('button', { name: 'Слияние дублей' }))
    expect(within(screen.getByRole('article')).getByRole('heading', { name: 'Слияние дублей' })).toBeInTheDocument()

    // рецензент: общие вход и выход, свои критерии
    await user.click(within(scheme).getByRole('button', { name: /Тест-аналитик/ }))
    const qa = screen.getByRole('article')
    expect(within(qa).getByText(/Шесть рецензентов работают параллельно/)).toBeInTheDocument()
    expect(within(qa).getByText('Валидируемость')).toBeInTheDocument()
  })

  it('opens an agent from the URL and shows the criteria matrix', () => {
    open('/agents?agent=knowledge')
    expect(within(screen.getByRole('article')).getByRole('link', { name: 'Открыть базу знаний' })).toHaveAttribute('href', '/knowledge')
    const matrix = screen.getByRole('table', { name: 'Кто за какие критерии отвечает' })
    expect(within(matrix).getByRole('img', { name: 'Контролёр логики правил: Непротиворечивость' })).toBeInTheDocument()
    expect(within(matrix).getAllByRole('img', { name: /^Инспектор требований:/ })).toHaveLength(10)
  })
})
