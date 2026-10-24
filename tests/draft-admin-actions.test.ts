import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'

const actions = vi.hoisted(() => ({
    confirm: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), stop: vi.fn(), refresh: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ confirmAction: actions.confirm, showAlert: vi.fn() }))
vi.mock('@/lib/draft', () => ({ pauseDraft: actions.pause, resumeDraft: actions.resume, resetDraft: actions.reset, stopDraft: actions.stop }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
let controls: ReturnType<typeof useDraftAdminControls>
function Probe() {
    controls = useDraftAdminControls({
        draftId: 'draft', confirmCopy: { stop: 'Stop', reset: 'Reset', pause: 'Pause', resume: 'Resume' },
        refresh: actions.refresh, onStopped: vi.fn(),
    })
    return null
}
beforeEach(async () => {
    vi.clearAllMocks()
    await act(async () => { screen = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => screen.unmount()) })

it.each(['Pause', 'Resume'] as const)('%s applies with one tap and refreshes the server answer', async action => {
    await act(async () => controls[`handle${action}Draft`]())
    expect(actions.confirm).not.toHaveBeenCalled()
    expect(actions[action === 'Pause' ? 'pause' : 'resume']).toHaveBeenCalledExactlyOnceWith('draft')
    expect(actions.refresh).toHaveBeenCalledOnce()
})

it.each(['Reset', 'Stop'] as const)('%s still requires confirmation', async action => {
    await act(async () => controls[`handle${action}Draft`]())
    expect(actions.confirm).toHaveBeenCalledOnce()
    expect(actions[action === 'Reset' ? 'reset' : 'stop']).not.toHaveBeenCalled()
})
