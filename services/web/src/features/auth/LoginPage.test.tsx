import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { setSession } from '@/mocks/data'
import { validateFile } from '@/features/documents/UploadDropzone'
import { renderWithProviders } from '@/test/render'
import { LoginPage } from './LoginPage'

describe('Login', () => {
  it('shows an error for wrong credentials and navigates on success', async () => {
    setSession(false)
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, { route: '/login', path: '/login' })
    await user.type(await screen.findByLabelText('Логин'), 'admin')
    await user.type(screen.getByLabelText('Пароль'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный логин или пароль')
    await user.clear(screen.getByLabelText('Пароль'))
    await user.type(screen.getByLabelText('Пароль'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByTestId('elsewhere')).toBeInTheDocument()
  })
})

describe('Upload validation', () => {
  it('accepts pdf/docx/md/txt and rejects other formats and big files', () => {
    expect(validateFile(new File(['x'], 'spec.PDF'))).toBeNull()
    expect(validateFile(new File(['x'], 'spec.md'))).toBeNull()
    expect(validateFile(new File(['x'], 'spec.xlsx'))).toBe('format')
    const big = new File(['x'], 'big.txt')
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    expect(validateFile(big)).toBe('size')
  })
})
