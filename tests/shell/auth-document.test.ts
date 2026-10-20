import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AuthDocumentForm } from '@/components/auth/AuthDocumentForm'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('@/components/auth/AuthForms', () => ({
    SignInForm: () => React.createElement('input', { placeholder: 'you@example.com' }),
    SignUpForm: () => React.createElement('input', { placeholder: 'Maple Manager' }),
}))

it.each(['/sign-in', '/sign-up'])('reserves the real form outside the lazy root on %s', pathname => {
    const html = renderToStaticMarkup(React.createElement(AuthDocumentForm, { pathname }))
    expect(html).toContain('id="pancake-auth-document"')
    expect(html).toContain('inert=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain(pathname === '/sign-in' ? 'you@example.com' : 'Maple Manager')
})

it('does not add an auth document to authenticated routes', () => {
    expect(renderToStaticMarkup(React.createElement(AuthDocumentForm, { pathname: '/profile' }))).toBe('')
})

it('releases the document form when startup fails', () => {
    const html = renderToStaticMarkup(React.createElement(AuthDocumentForm, { pathname: '/sign-in' }))
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    const handlers = new Map<string, () => void>()
    const remove = vi.fn()
    new Function('window', 'document', script!)({ addEventListener: (event: string, handler: () => void) => handlers.set(event, handler) }, { getElementById: () => ({ remove }) })
    handlers.get('error')!()
    handlers.get('unhandledrejection')!()
    expect(remove).toHaveBeenCalledTimes(2)
})
