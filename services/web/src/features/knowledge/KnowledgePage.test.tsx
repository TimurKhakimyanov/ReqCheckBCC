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

  it('shows empty folders in the tree and an overview with folders, recent edits and hubs', async () => {
    open()
    const tree = await screen.findByRole('navigation', { name: 'Папки и заметки' })
    expect(await within(tree).findByRole('button', { name: 'Черновики' })).toBeInTheDocument()
    const byFolder = await screen.findByRole('list', { name: 'Страницы по папкам' })
    expect(within(byFolder).getByRole('button', { name: /Банк\s*4/ })).toBeInTheDocument()
    const recent = screen.getByRole('list', { name: 'Недавние правки' })
    expect(within(recent).getAllByRole('button')[0]).toHaveTextContent('Карты: лимиты и ПИН-код')
    const hubs = await screen.findByRole('list', { name: 'Самые связанные' })
    expect(within(hubs).getByRole('button', { name: /Глоссарий банка/ })).toBeInTheDocument()
  })

  it('creates, renames and deletes folders; contents move with them', async () => {
    const user = userEvent.setup()
    open('/knowledge?folder=Банк')
    await user.click(await screen.findByRole('button', { name: 'Подпапка' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Внутри папки')).toHaveValue('Банк')
    await user.type(within(dialog).getByLabelText('Название'), 'Депозиты')
    await user.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Депозиты' })).toBeInTheDocument()
    expect(db.knowledgeFolders).toContain('Банк/Депозиты')

    // переименовать «Банк/Карты» и перенести в корень
    const tree = screen.getByRole('navigation', { name: 'Папки и заметки' })
    await user.click(within(tree).getByRole('button', { name: 'Карты' }))
    await user.click(await screen.findByRole('button', { name: 'Переименовать или перенести' }))
    dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Название')
    await user.clear(name)
    await user.type(name, 'Карточные продукты')
    await user.selectOptions(within(dialog).getByLabelText('Внутри папки'), '')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Карточные продукты' })).toBeInTheDocument()
    expect(db.knowledge.find((k) => k.id === 'kb-cards')!.folder).toBe('Карточные продукты')

    // удалить папку: страница переезжает в корень
    await user.click(screen.getByRole('button', { name: 'Удалить папку' }))
    dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('переедут в «Вся база»')
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(db.knowledge.find((k) => k.id === 'kb-cards')!.folder).toBe(''))
    expect(await screen.findByRole('heading', { level: 2, name: 'База знаний' })).toBeInTheDocument()
  })

  it('searches page text and shows highlighted snippets', async () => {
    const user = userEvent.setup()
    open()
    await user.type(await screen.findByRole('searchbox', { name: 'Поиск по страницам' }), 'тиын')
    const results = await screen.findByRole('region', { name: 'Найдено в тексте' })
    const hit = await within(results).findByRole('button', { name: /^Глоссарий банка/ })
    expect(within(hit).getAllByText(/тиын/i, { selector: 'mark' }).length).toBeGreaterThan(0)
    await user.click(hit)
    expect(await screen.findByRole('heading', { level: 2, name: 'Глоссарий банка' })).toBeInTheDocument()
  })

  it('renaming a page fixes [[links]] to it and shows its local graph', async () => {
    const user = userEvent.setup()
    open('/knowledge?note=kb-glossary')
    expect(await screen.findByRole('img', { name: /Связи страницы: заметок 4/ })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Редактировать' }))
    const title = screen.getByLabelText('Название')
    await user.clear(title)
    await user.type(title, 'Словарь банка')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Словарь банка' })).toBeInTheDocument()
    expect(db.knowledge.find((k) => k.id === 'kb-cards')!._content).toContain('[[Словарь банка]]')
  })

  it('draws the knowledge graph', async () => {
    open('/knowledge?view=graph')
    const svg = await screen.findByRole('img', { name: /Граф базы знаний: заметок 5/ })
    await waitFor(() => expect(svg.querySelectorAll('circle').length).toBe(5))
    expect(within(svg).getAllByText('Глоссарий банка').length).toBeGreaterThan(0)
  })
})
