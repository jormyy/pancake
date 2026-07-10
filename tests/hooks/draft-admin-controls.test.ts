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
