import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useUnsentFormUpdate } from '@/hooks/use-unsent-form-update'
import { holdPwaUpdate, isPwaUpdateHeld } from '@/lib/pwa-update-guard'

const focus = vi.hoisted(() => ({ value: true }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => focus.value }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Form({ dirty }: { dirty: boolean }) {
    useUnsentFormUpdate(dirty, 'unsent form')
    return null
}

it('holds mounted unsent work across focus changes and keeps independent mutation holds', async () => {
    vi.stubGlobal('window', new EventTarget())
    let screen!: ReactTestRenderer
    let releaseMutation: (() => void) | undefined
    try {
        focus.value = true
        await act(async () => { screen = create(React.createElement(Form, { dirty: false })) })
        expect(isPwaUpdateHeld()).toBe(false)
        await act(async () => screen.update(React.createElement(Form, { dirty: true })))
        expect(isPwaUpdateHeld()).toBe(true)
        focus.value = false
        await act(async () => screen.update(React.createElement(Form, { dirty: true })))
        expect(isPwaUpdateHeld()).toBe(true)
        focus.value = true
        await act(async () => screen.update(React.createElement(Form, { dirty: true })))
        expect(isPwaUpdateHeld()).toBe(true)
        releaseMutation = holdPwaUpdate('pending write')
        await act(async () => screen.update(React.createElement(Form, { dirty: false })))
        expect(isPwaUpdateHeld()).toBe(true)
        releaseMutation()
        expect(isPwaUpdateHeld()).toBe(false)
        await act(async () => screen.update(React.createElement(Form, { dirty: true })))
        await act(async () => screen.unmount())
        expect(isPwaUpdateHeld()).toBe(false)
    } finally {
        releaseMutation?.()
        await act(async () => screen?.unmount())
        focus.value = true
        vi.unstubAllGlobals()
    }
})
