import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => await vi.importActual('react-native-web'))

it('marks a button busy and disabled while its request is open', async () => {
    const { Button } = await import('@/components/ui/Button')
    const saving = renderToStaticMarkup(React.createElement(Button, { title: 'Sign In', loading: true, onPress: () => {} }))
    const idle = renderToStaticMarkup(React.createElement(Button, { title: 'Sign In', onPress: () => {} }))
    expect(saving).toContain('aria-busy="true"')
    expect(saving).toContain('aria-disabled="true"')
    expect(idle).not.toContain('aria-busy="true"')
    expect(idle).not.toContain('aria-disabled="true"')
})
