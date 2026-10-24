import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'

const mocks = vi.hoisted(() => ({
    confirmAction: vi.fn(),
    pauseDraft: vi.fn(),
    resetDraft: vi.fn(),
    resumeDraft: vi.fn(),
    stopDraft: vi.fn(),
}))

vi.mock('@/lib/alert', () => ({
    confirmAction: mocks.confirmAction,
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    showAlert: vi.fn(),
}))
vi.mock('@/lib/draft', () => ({
    pauseDraft: mocks.pauseDraft,
    resetDraft: mocks.resetDraft,
    resumeDraft: mocks.resumeDraft,
    stopDraft: mocks.stopDraft,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('draft admin action ownership', () => {
    it('keeps pending commands separate across draft switches and returns', async () => {
        const first = deferred()
        const second = deferred()
        mocks.pauseDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { onConfirm() })
        let latest!: ReturnType<typeof useDraftAdminControls>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useDraftAdminControls({
                draftId,
                confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
                refresh: vi.fn(),
                onStopped: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })) })
        await act(async () => { latest.handlePauseDraft() })
        expect(latest.adminBusy).toBe(true)
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
        expect(latest.adminBusy).toBe(false)
        await act(async () => { latest.handlePauseDraft() })
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-a' })) })
        expect(latest.adminBusy).toBe(true)
        await act(async () => { latest.handlePauseDraft() })
        expect(mocks.pauseDraft.mock.calls.map(([id]) => id)).toEqual(['draft-a', 'draft-b'])
        await act(async () => { first.resolve(); await first.promise })
        expect(latest.adminBusy).toBe(false)
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
        expect(latest.adminBusy).toBe(true)
        await act(async () => { second.resolve(); await second.promise })
        expect(latest.adminBusy).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it.each([
        ['handlePauseDraft', 'pauseDraft'],
        ['handleResumeDraft', 'resumeDraft'],
        ['handleResetDraft', 'resetDraft'],
        ['handleStopDraft', 'stopDraft'],
    ] as const)('holds repeated %s confirmations until the request finishes', async (handler, mutation) => {
        const pending = deferred()
        mocks[mutation].mockReturnValueOnce(pending.promise)
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { onConfirm() })
        let latest!: ReturnType<typeof useDraftAdminControls>
        const Probe = () => {
            latest = useDraftAdminControls({
                draftId: 'draft-a',
                confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
                refresh: vi.fn(),
                onStopped: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest[handler](); latest[handler](); await Promise.resolve() })
        expect(mocks[mutation]).toHaveBeenCalledTimes(1)
        await act(async () => { pending.resolve(); await pending.promise })
        await act(async () => { latest[handler](); await Promise.resolve() })
        expect(mocks[mutation]).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })

    it('blocks conflicting commands while the same draft has a pending command', async () => {
        const pending = deferred()
        mocks.pauseDraft.mockReturnValueOnce(pending.promise)
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { onConfirm() })
        let latest!: ReturnType<typeof useDraftAdminControls>
        const Probe = () => {
            latest = useDraftAdminControls({
                draftId: 'draft-a',
                confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
                refresh: vi.fn(),
                onStopped: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.handlePauseDraft(); latest.handleResetDraft(); await Promise.resolve() })
        expect(mocks.pauseDraft).toHaveBeenCalledTimes(1)
        expect(mocks.resetDraft).not.toHaveBeenCalled()
        await act(async () => { pending.resolve(); await pending.promise })
        await act(async () => { latest.handleResetDraft(); await Promise.resolve() })
        expect(mocks.resetDraft).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

    it('cancels a root confirmation when the active draft changes', async () => {
        let confirm!: () => void
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
        let latest!: ReturnType<typeof useDraftAdminControls>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useDraftAdminControls({
                draftId,
                confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
                refresh: vi.fn(),
                onStopped: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })) })
        await act(async () => { latest.handleResetDraft() })
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
        await act(async () => { confirm(); await Promise.resolve() })

        expect(mocks.resetDraft).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('does not refresh or navigate a replacement draft after an old action settles', async () => {
        const stop = deferred()
        mocks.stopDraft.mockReturnValueOnce(stop.promise)
        let confirm!: () => void
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
        const refresh = vi.fn()
        const onStopped = vi.fn()
        let latest!: ReturnType<typeof useDraftAdminControls>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useDraftAdminControls({
                draftId,
                confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
                refresh,
                onStopped,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })) })
        await act(async () => { latest.handleStopDraft(); confirm(); await Promise.resolve() })
        expect(mocks.stopDraft).toHaveBeenCalledWith('draft-a')
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
        await act(async () => { stop.resolve(); await stop.promise })

        expect(refresh).not.toHaveBeenCalled()
        expect(onStopped).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})

it('rechecks activity and the captured owner after a confirmation closes', async () => {
    let allowed = true
    const oldOwner = () => allowed
    let latest!: ReturnType<typeof useDraftAdminControls>
    const Probe = ({ canAct }: { canAct: () => boolean }) => {
        latest = useDraftAdminControls({
            draftId: 'draft', canAct,
            confirmCopy: { stop: 'stop', reset: 'reset', pause: 'pause', resume: 'resume' },
            refresh: vi.fn(), onStopped: vi.fn(),
        })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { canAct: oldOwner })) })
    await act(async () => { latest.handleResetDraft() })
    const confirm = mocks.confirmAction.mock.calls.at(-1)![2] as () => void
    allowed = false
    await act(async () => { renderer.update(React.createElement(Probe, { canAct: () => true })); confirm() })
    expect(mocks.resetDraft).not.toHaveBeenCalled()
    await act(async () => { latest.handleResetDraft() })
    await act(async () => { (mocks.confirmAction.mock.calls.at(-1)![2] as () => void)() })
    expect(mocks.resetDraft).toHaveBeenCalledExactlyOnceWith('draft')
    await act(async () => { renderer.unmount() })
})
