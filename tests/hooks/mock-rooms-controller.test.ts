import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMockRoomsController } from '@/hooks/use-mock-rooms-controller'
import type { MockDraftRoom } from '@/lib/mockDraftRooms'

const mocks = vi.hoisted(() => ({
    createMockDraftRoom: vi.fn(),
    joinMockDraftRoom: vi.fn(),
    leaveMockDraftRoom: vi.fn(),
    startMockDraftRoom: vi.fn(),
}))

vi.mock('@/lib/mockDraftRooms', () => ({
    createMockDraftRoom: mocks.createMockDraftRoom,
    joinMockDraftRoom: mocks.joinMockDraftRoom,
    leaveMockDraftRoom: mocks.leaveMockDraftRoom,
    startMockDraftRoom: mocks.startMockDraftRoom,
}))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

const room = { id: 'room-a', draftType: 'auction' } as MockDraftRoom

beforeEach(() => {
    vi.clearAllMocks()
})

describe('mock room action ownership', () => {
    it('does not navigate a replacement owner after an old start settles', async () => {
        const start = deferred<{ id: string }>()
        mocks.startMockDraftRoom.mockReturnValue(start.promise)
        const openA = vi.fn()
        const openB = vi.fn()
        let latest!: ReturnType<typeof useMockRoomsController>
        const Probe = ({ owner }: { owner: 'a' | 'b' }) => {
            latest = useMockRoomsController({
                leagueId: `league-${owner}`,
                memberId: `member-${owner}`,
                nominationMode: 'user_nominated',
                draftTimerSeconds: 30,
                rookieRounds: 3,
                rookieTimerExpiryBehavior: 'auto_pick',
                refreshRooms: vi.fn(async () => undefined),
                openDraftRoom: owner === 'a' ? openA : openB,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleStartMockRoom(room); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
        await act(async () => { start.resolve({ id: 'draft-a' }); await pending })

        expect(openA).not.toHaveBeenCalled()
        expect(openB).not.toHaveBeenCalled()
        expect(latest.roomActionLoading).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('preserves the replacement owner form and serializes room actions', async () => {
        const createRequest = deferred<void>()
        const join = deferred<void>()
        mocks.createMockDraftRoom.mockReturnValue(createRequest.promise)
        mocks.joinMockDraftRoom.mockReturnValue(join.promise)
        mocks.leaveMockDraftRoom.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useMockRoomsController>
        const Probe = ({ owner }: { owner: 'a' | 'b' }) => {
            latest = useMockRoomsController({
                leagueId: `league-${owner}`,
                memberId: `member-${owner}`,
                nominationMode: 'user_nominated',
                draftTimerSeconds: 30,
                rookieRounds: 3,
                rookieTimerExpiryBehavior: 'auto_pick',
                refreshRooms: vi.fn(async () => undefined),
                openDraftRoom: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
        let pendingCreate!: Promise<void>
        await act(async () => {
            latest.setRoomName('A room')
            pendingCreate = latest.handleCreateMockRoom()
            await Promise.resolve()
        })
        await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
        await act(async () => { latest.setRoomName('B room') })
        await act(async () => { createRequest.resolve(); await pendingCreate })
        expect(latest.roomName).toBe('B room')

        let pendingJoin!: Promise<void>
        await act(async () => {
            pendingJoin = latest.handleJoinMockRoom(room)
            void latest.handleLeaveMockRoom(room)
            await Promise.resolve()
        })
        expect(mocks.joinMockDraftRoom).toHaveBeenCalledTimes(1)
        expect(mocks.leaveMockDraftRoom).not.toHaveBeenCalled()
        await act(async () => { join.resolve(); await pendingJoin })
        await act(async () => { renderer.unmount() })
    })
})
