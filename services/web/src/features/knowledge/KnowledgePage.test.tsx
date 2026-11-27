import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { buildTree, KnowledgePage } from './KnowledgePage'
import { parseBlocks } from './WikiMarkdown'

const open = (route = '/knowledge') => renderWithProviders(<KnowledgePage />, { route, path: '/knowledge' })

describe('Knowledge wiki', () => {
  it('builds a nested folder tree', () => {
    const tree = buildTree(db.knowledge)
    expect(tree.folders.map((f) => f.name)).toEqual(['Банк', 'Стандарты'])
    const bank = tree.folders[0]
    expect(bank.folders.map((f) => f.name)).toEqual(['Карты', 'Шаблоны'])
    expect(bank.total).toBe(4)
  })

  it('parses markdown blocks: headings, tables, lists, quotes', () => {
    const kinds = parseBlocks('# T\n\n| a | b |\n| :--- | :--- |\n| 1 | 2 |\n\n- x\n- y\n\n> q').map((b) => b.type)
    expect(kinds).toEqual(['h', 'table', 'ul', 'quote'])
  })

  it('shows a note rendered from markdown with its links and backlinks', async () => {
    const user = userEvent.setup()
    open()
    const tree = await screen.findByRole('navigation', { name: 'Папки и заметки' })
    await user.click(await within(tree).findByRole('button', { name: /Глоссарий банка/ }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Глоссарий банка' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '1/100 тенге' })).toBeInTheDocument()
    const back = screen.getByText('Ссылаются сюда').closest('section')!
    expect(within(back).getByRole('button', { name: 'Карты: лимиты и ПИН-код' })).toBeInTheDocument()
    expect(within(back).getByRole('button', { name: 'Шаблон ТЗ банка' })).toBeInTheDocument()
    const crit = screen.getByText('Критерии в тексте').closest('section')!
    expect(within(crit).getByText('Однозначность')).toBeInTheDocument()
  })

  it('creates a missing note from a [[link]] and edits an existing one', async () => {
    const user = userEvent.setup()
    open('/knowledge?note=kb-cards')
    const missing = await screen.findAllByRole('button', { name: 'Политика ИБ для мобильного банка' })
    await user.click(missing[0])
    expect(screen.getByLabelText('Название')).toHaveValue('Политика ИБ для мобильного банка')
    expect(screen.getByLabelText('Папка')).toHaveValue('Банк/Карты')
    await user.type(screen.getByLabelText('Текст'), 'ПИН-код не логируется.')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Политика ИБ для мобильного банка' })).toBeInTheDocument()
    const created = db.knowledge.find((k) => k.title === 'Политика ИБ для мобильного банка')!
    expect(created.folder).toBe('Банк/Карты')

    await user.click(screen.getByRole('button', { name: 'Редактировать' }))
    const area = screen.getByLabelText('Текст')
    await user.clear(area)
    await user.type(area, 'Шифрование ПИН-блока обязательно.')
    await user.clear(screen.getByLabelText('Папка'))
    await user.type(screen.getByLabelText('Папка'), 'ИБ')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(created._content).toBe('Шифрование ПИН-блока обязательно.'))
    expect(created.folder).toBe('ИБ')
  })

  it('built-in material can only be moved', async () => {
    const user = userEvent.setup()
    open('/knowledge?note=kb-builtin')
    await user.click(await screen.findByRole('button', { name: 'Перенести' }))
    expect(screen.getByLabelText('Название')).toBeDisabled()
    expect(screen.queryByLabelText('Текст')).toBeNull()
  })

  it('draws the knowledge graph', async () => {
    open('/knowledge?view=graph')
    const svg = await screen.findByRole('img', { name: /Граф базы знаний: заметок 5/ })
    await waitFor(() => expect(svg.querySelectorAll('circle').length).toBe(5))
    expect(within(svg).getAllByText('Глоссарий банка').length).toBeGreaterThan(0)
  })
})
