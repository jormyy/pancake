import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

const mocks = vi.hoisted(() => ({
    getJoinableDraft: vi.fn(),
    push: vi.fn(),
    showAlert: vi.fn(),
}))

vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/draft', () => ({ getJoinableDraft: mocks.getJoinableDraft }))
vi.mock('@/lib/alert', () => ({
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    showAlert: mocks.showAlert,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('draft room launcher ownership', () => {
    it('routes only the active league when requests resolve out of order', async () => {
        const first = deferred<{ id: string; draftType: 'auction' } | null>()
        const second = deferred<{ id: string; draftType: 'snake' } | null>()
        mocks.getJoinableDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        let latest!: ReturnType<typeof useDraftRoomLauncher>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useDraftRoomLauncher(leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })) })
        let oldRequest!: Promise<unknown>
        await act(async () => { oldRequest = latest.openDraftRoom(); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        let newRequest!: Promise<unknown>
        await act(async () => { newRequest = latest.openDraftRoom(); await Promise.resolve() })

        await act(async () => { second.resolve({ id: 'draft-b', draftType: 'snake' }); await newRequest })
        await act(async () => { first.resolve({ id: 'draft-a', draftType: 'auction' }); await oldRequest })

        expect(mocks.push).toHaveBeenCalledOnce()
        expect(mocks.push).toHaveBeenCalledWith({
            pathname: '/(modals)/rookie-draft-room',
            params: { draftId: 'draft-b' },
        })
        expect(latest.draftLoading).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('deduplicates same-league launches and exposes retryable errors', async () => {
        const request = deferred<null>()
        mocks.getJoinableDraft.mockReturnValueOnce(request.promise)
        let latest!: ReturnType<typeof useDraftRoomLauncher>
        const Probe = () => {
            latest = useDraftRoomLauncher('league', { notifyOnError: true })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let launch!: Promise<unknown>
        await act(async () => {
            launch = latest.openDraftRoom()
            void latest.openDraftRoom()
            await Promise.resolve()
        })
        expect(mocks.getJoinableDraft).toHaveBeenCalledOnce()
        await act(async () => { request.resolve(null); await launch })

        mocks.getJoinableDraft.mockRejectedValueOnce(new Error('draft service offline'))
        await act(async () => { await latest.openDraftRoom({ fallbackOnMissing: false }) })
        expect(latest.draftError).toBe('draft service offline')
        expect(mocks.showAlert).toHaveBeenCalledWith('Could not open draft room', 'draft service offline')
        await act(async () => { renderer.unmount() })
    })
})

describe('resolved draft launcher', () => {
    it('returns the checked room without adding a second browser history route', async () => {
        const draft = { id: 'resolved-auction', draftType: 'auction' }
        mocks.getJoinableDraft.mockResolvedValue(draft)
        let latest!: ReturnType<typeof useDraftRoomLauncher>
        const Probe = () => {
            latest = useDraftRoomLauncher('league', { renderAuctionInline: true })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.openDraftRoom({ fallbackOnMissing: false }) })
        expect(mocks.getJoinableDraft).toHaveBeenCalledWith('league', { includeCompletedRookie: true })
        expect(mocks.push).not.toHaveBeenCalled()
        expect(latest.draft).toEqual(draft)
        expect(latest.draftChecked).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('hides a resolved room on league change and cannot expose a late prior lookup', async () => {
        const late = deferred<{ id: string; draftType: 'auction' } | null>()
        mocks.getJoinableDraft.mockResolvedValueOnce({ id: 'old', draftType: 'auction' }).mockReturnValueOnce(late.promise).mockResolvedValueOnce({ id: 'new', draftType: 'snake' })
        let latest!: ReturnType<typeof useDraftRoomLauncher>
        const Probe = ({ leagueId }: { leagueId: string }) => { latest = useDraftRoomLauncher(leagueId, { renderAuctionInline: true }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'a' })) })
        await act(async () => { await latest.openDraftRoom() })
        expect(latest.draft?.id).toBe('old')
        let oldRequest!: Promise<unknown>
        await act(async () => { oldRequest = latest.openDraftRoom(); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'b' })) })
        expect(latest.draft).toBeNull()
        await act(async () => { await latest.openDraftRoom() })
        await act(async () => { late.resolve({ id: 'late-old', draftType: 'auction' }); await oldRequest })
        expect(latest.draft?.id).toBe('new')
        expect(mocks.push).toHaveBeenCalledOnce()
        expect(mocks.push).toHaveBeenCalledWith({ pathname: '/(modals)/rookie-draft-room', params: { draftId: 'new' } })
        mocks.getJoinableDraft.mockRejectedValueOnce(new Error('offline'))
        await act(async () => { await latest.openDraftRoom() })
        expect(latest.draft).toBeNull()
        expect(latest.draftError).toBe('offline')
        await act(async () => { renderer.unmount() })
    })
})

it('fences same-league membership changes and an unmounted launcher', async () => {
    const old = deferred<{ id: string; draftType: 'auction' } | null>()
    const pendingUnmount = deferred<{ id: string; draftType: 'snake' } | null>()
    mocks.getJoinableDraft.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ id: 'current', draftType: 'auction' }).mockReturnValueOnce(pendingUnmount.promise)
    let latest!: ReturnType<typeof useDraftRoomLauncher>
    const Probe = ({ member }: { member: string }) => { latest = useDraftRoomLauncher('same-league', { scopeKey: member, renderAuctionInline: true }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { member: 'previous-member' })) })
    let prior!: Promise<unknown>
    await act(async () => { prior = latest.openDraftRoom(); await Promise.resolve() })
    await act(async () => { renderer.update(React.createElement(Probe, { member: 'current-member' })) })
    expect(latest.draft).toBeNull()
    await act(async () => { await latest.openDraftRoom() })
    await act(async () => { old.resolve({ id: 'old-member-room', draftType: 'auction' }); await prior })
    expect(latest.draft?.id).toBe('current')
    let unmounted!: Promise<unknown>
    await act(async () => { unmounted = latest.openDraftRoom(); await Promise.resolve() })
    await act(async () => { renderer.unmount() })
    await act(async () => { pendingUnmount.resolve({ id: 'late-snake', draftType: 'snake' }); expect(await unmounted).toBe('stale') })
    expect(mocks.push).not.toHaveBeenCalled()
})
