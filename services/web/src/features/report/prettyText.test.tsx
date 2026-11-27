import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { prettyText } from './prettyText'

const DOC = '# Заголовок\n\n| Поле | Значение |\n| :--- | :--- |\n| Версия | **1.2** |\nТекст # не заголовок'

describe('prettyText', () => {
  it('keeps the exact text (offsets of quotes do not move) and only wraps Markdown syntax', () => {
    const { container } = render(<div>{prettyText(DOC, 0, DOC)}</div>)
    expect(container.textContent).toBe(DOC)
    expect(container.querySelector('.md-h1')?.textContent).toBe('Заголовок')
    expect(container.querySelector('.md-sep')?.textContent).toBe('| :--- | :--- |')
    // «#», «**» и крайние «|» строк таблицы скрыты; внутренние «|» — бледные разделители
    expect([...container.querySelectorAll('.md-syn')].map((e) => e.textContent)).toEqual(['# ', '|', '|', '|', '**', '**', '|'])
    expect(container.querySelectorAll('.md-pipe').length).toBe(2)
  })

  it('recognises a heading only at the start of a line, also inside a chunk', () => {
    const at = DOC.indexOf('Текст')
    const { container } = render(<div>{prettyText(DOC, at, DOC.slice(at))}</div>)
    expect(container.querySelector('.md-h')).toBeNull()
    const mid = render(<div>{prettyText(DOC, 2, DOC.slice(2, 11))}</div>)
    expect(mid.container.querySelector('.md-h')).toBeNull()
    expect(mid.container.textContent).toBe(DOC.slice(2, 11))
  })
})
