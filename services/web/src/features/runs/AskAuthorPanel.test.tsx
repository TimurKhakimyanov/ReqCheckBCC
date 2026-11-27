import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db, newRun, sampleReport } from '@/mocks/data'
import { renderWithProviders } from '@/test/render'
import { AskAuthorPanel } from './AskAuthorPanel'

describe('Ask the author during a run (like bbc-agent --ask)', () => {
  it('shows the questions the run stopped at and sends the answers back to it', async () => {
    const user = userEvent.setup()
    const run = newRun(db.documents[0], 'gemini', 'gemini-2.5-flash', { ask_author: true })
    Object.assign(run, { _askedAt: Date.now() }) // прогон остановился на вопросах
    renderWithProviders(<AskAuthorPanel run={run} active />)
    const panel = await screen.findByRole('region', { name: 'Агент ждёт ваших ответов' })
    const qs = sampleReport.questions!
    for (const q of qs) expect(within(panel).getByText(q.question)).toBeInTheDocument()

    const send = within(panel).getByRole('button', { name: 'Отправить ответы' })
    expect(send).toBeDisabled()
    await user.click(within(within(panel).getByRole('article', { name: qs[0].id })).getAllByRole('radio')[1])
    expect(within(panel).getByText(`Отвечено 1 из ${qs.length}`)).toBeInTheDocument()
    await user.click(send)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Агент ждёт ваших ответов' })).toBeNull())
    expect((run as unknown as { _answers: Record<string, string> })._answers).toEqual({ [qs[0].id]: qs[0].options![1] })
  })

  it('stays hidden when the run was started without asking the author', async () => {
    const run = newRun(db.documents[0], 'gemini', 'gemini-2.5-flash', {})
    Object.assign(run, { _askedAt: Date.now() })
    const { container } = renderWithProviders(<AskAuthorPanel run={run} active />)
    await new Promise((r) => setTimeout(r, 50))
    expect(container).toBeEmptyDOMElement()
  })
})
