import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildSegments, type Range } from './highlight'
import { findHeadings, renderDocument, type RenderMark } from './prettyText'

const DOC = '# Заголовок\n\n| Поле | Значение |\n| :--- | :--- |\n| Версия | **1.2** |\n* **Ф-1.** Пункт списка\nТекст # не заголовок'

const mark: RenderMark = (p, key, children) => (
  <mark key={key} data-ids={p.ranges.map((r) => r.findingId).join(' ')} data-loc={p.ranges.filter((r) => r.start === p.start).map((r) => r.findingId).join(' ') || undefined}>
    {children}
  </mark>
)

const renderDoc = (text: string, ranges: Range[] = []) => render(<div>{renderDocument(text, buildSegments(text, ranges), mark)}</div>)

describe('document renderer', () => {
  it('turns Markdown lines into headings, tables, list items and paragraphs', () => {
    const { container } = renderDoc(DOC)
    expect(container.querySelector('.md-h1')?.textContent).toBe('# Заголовок')
    expect([...container.querySelectorAll('th')].map((e) => e.textContent)).toEqual(['Поле', 'Значение'])
    expect([...container.querySelectorAll('td')].map((e) => e.textContent)).toEqual(['Версия', '**1.2**'])
    // «**» скрыты, текст между ними — жирный
    expect(container.querySelector('td strong')?.textContent).toBe('1.2')
    expect(container.querySelector('.md-li strong')?.textContent).toBe('Ф-1.')
    // строка-разделитель таблицы не рисуется, «#» в середине строки — не заголовок
    expect(container.textContent).not.toContain(':---')
    expect(container.querySelectorAll('.md-h')).toHaveLength(1)
    expect(container.querySelector('p.md-p')?.textContent).toBe('Текст # не заголовок')
  })

  it('splits a highlight across table cells, keeping data-loc on the first piece only', () => {
    const quote = 'Версия | **1.2'
    const start = DOC.indexOf(quote)
    const { container } = renderDoc(DOC, [{ start, end: start + quote.length, findingId: 'D-001', locIndex: 0, severity: 'major' }])
    const marks = [...container.querySelectorAll('mark')]
    expect(marks.map((m) => m.closest('td') !== null)).toEqual([true, true])
    expect(marks.map((m) => m.textContent)).toEqual(['Версия', '**1.2'])
    expect(marks.map((m) => m.getAttribute('data-loc'))).toEqual(['D-001', null])
  })

  it('lists headings with their offsets', () => {
    expect(findHeadings('# A\nтекст\n## **B**\n')).toEqual([
      { start: 0, level: 1, title: 'A' },
      { start: 10, level: 2, title: 'B' },
    ])
  })
})
