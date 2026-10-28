import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMockRoomsController } from '@/hooks/use-mock-rooms-controller'
import type { MockDraftRoom } from '@/lib/mockDraftRooms'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

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

    it('does not navigate after an in-flight start outlives the controller', async () => {
        const start = deferred<{ id: string }>()
        mocks.startMockDraftRoom.mockReturnValue(start.promise)
        const openDraftRoom = vi.fn()
        let latest!: ReturnType<typeof useMockRoomsController>
        const Probe = () => {
            latest = useMockRoomsController({
                leagueId: 'league-a',
                memberId: 'member-a',
                refreshRooms: vi.fn(async () => undefined),
                openDraftRoom,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleStartMockRoom(room); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { start.resolve({ id: 'draft-a' }); await pending })

        expect(openDraftRoom).not.toHaveBeenCalled()
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
                refreshRooms: vi.fn(async () => undefined),
                openDraftRoom: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
        let pendingCreate!: Promise<boolean | undefined>
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

it('owns mock options separately and defaults each room type', async () => {
    let latest!: ReturnType<typeof useMockRoomsController>
    const Probe = () => {
        latest = useMockRoomsController({ leagueId: 'league', memberId: 'member', refreshRooms: vi.fn(async () => {}), openDraftRoom: vi.fn() })
        return null
    }
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(Probe)) })
        expect(latest.mockDraftTimerSeconds).toBe(60)
        await act(async () => latest.setMockDraftTimerSeconds(90))
        await act(async () => latest.setRoomDraftType('snake'))
        expect(latest.mockDraftTimerSeconds).toBe(86400)
        await act(async () => latest.setMockDraftTimerSeconds(5400))
        await act(async () => { await latest.handleCreateMockRoom() })
        expect(mocks.createMockDraftRoom).toHaveBeenLastCalledWith(expect.objectContaining({ draftType: 'snake', timerSeconds: 5400 }))
        await act(async () => latest.setRoomDraftType('auction'))
        expect(latest.mockDraftTimerSeconds).toBe(60)
    } finally { await act(async () => screen.unmount()) }
})

it('does not complete a replacement owner composer after an old room refresh finishes', async () => {
    const refresh = deferred<void>()
    mocks.createMockDraftRoom.mockResolvedValue(undefined)
    let latest!: ReturnType<typeof useMockRoomsController>
    const Probe = ({ owner }: { owner: 'a' | 'b' }) => {
        latest = useMockRoomsController({ leagueId: `league-${owner}`, memberId: `member-${owner}`, refreshRooms: () => refresh.promise, openDraftRoom: vi.fn() })
        return null
    }
    let renderer!: ReactTestRenderer
    let pending!: ReturnType<typeof latest.handleCreateMockRoom>
    try {
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
        await act(async () => { pending = latest.handleCreateMockRoom(); await Promise.resolve() })
        await act(async () => renderer.update(React.createElement(Probe, { owner: 'b' })))
        await act(async () => latest.setRoomName('Replacement draft'))
        let completed: boolean | undefined
        await act(async () => { refresh.resolve(); completed = await pending })
        expect(completed).not.toBe(true)
        expect(latest.roomName).toBe('Replacement draft')
    } finally { await act(async () => renderer?.unmount()) }
})
