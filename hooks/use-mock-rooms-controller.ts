import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { leagueDateTimeInput, parseLeagueDateTime } from '@/lib/timezone'
import { useEffect, useRef, useState } from 'react'
import {
    createMockDraftRoom,
    deleteMockDraftRoom,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
} from '@/lib/mockDraftRooms'
import type { NominationOrderMode, RookieTimerExpiryBehavior } from '@/lib/draft'
import type { DraftTimerOption, RookieRoundOption } from '@/lib/draft-options'
import { showAlert } from '@/lib/alert'

type MockRoomControllerOptions = {
    leagueId: string | undefined
    memberId: string | undefined
    refreshRooms: () => Promise<void>
    openDraftRoom: (draftId: string, draftType: string) => void
}

function defaultRoomDateInput(timezone: string): string {
    return leagueDateTimeInput(new Date(Date.now() + 30 * 60_000), timezone)
}

export function useMockRoomsController(options: MockRoomControllerOptions) {
    const timezone = useLeagueTimezone()
    const ownerKey = options.leagueId && options.memberId
        ? `${options.leagueId}:${options.memberId}`
        : null
    const activeOwnerKeyRef = useRef(ownerKey)
    const renderedOwnerKeyRef = useRef(ownerKey)
    const generationRef = useRef(0)
    activeOwnerKeyRef.current = ownerKey
    if (renderedOwnerKeyRef.current !== ownerKey) {
        renderedOwnerKeyRef.current = ownerKey
        generationRef.current += 1
    }
    type Action = { ownerKey: string; generation: number; token: symbol; kind: 'create' | 'room' }
    const activeActionRef = useRef<Action | null>(null)
    const [busy, setBusy] = useState<Action | null>(null)
    const [stateOwnerKey, setStateOwnerKey] = useState(ownerKey)
    const [roomName, setRoomName] = useState('')
    const [roomDraftType, setRoomDraftType] = useState<MockDraftRoomKind>('auction')
    const [roomScheduledAt, setRoomScheduledAt] = useState(() => defaultRoomDateInput(timezone))
    const [mockNominationMode, setMockNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [mockDraftTimerSeconds, setMockDraftTimerSeconds] = useState<DraftTimerOption>(60)
    const [mockRookieRounds, setMockRookieRounds] = useState<RookieRoundOption>(3)
    const [mockRookieTimerExpiryBehavior, setMockRookieTimerExpiryBehavior] = useState<RookieTimerExpiryBehavior>('auto_pick')
    const changeRoomDraftType = (kind: MockDraftRoomKind) => {
        setRoomDraftType(kind)
        setMockNominationMode('user_nominated')
        setMockDraftTimerSeconds(kind === 'snake' ? 86400 : 60)
        setMockRookieRounds(3)
        setMockRookieTimerExpiryBehavior('auto_pick')
    }

    useEffect(() => {
        activeActionRef.current = null
        setBusy(null)
        setStateOwnerKey(ownerKey)
        setRoomName('')
        setRoomDraftType('auction')
        setMockNominationMode('user_nominated')
        setMockDraftTimerSeconds(60)
        setMockRookieRounds(3)
        setMockRookieTimerExpiryBehavior('auto_pick')
        setRoomScheduledAt(defaultRoomDateInput(timezone))
        return () => {
            generationRef.current += 1
            activeActionRef.current = null
        }
    }, [ownerKey, timezone])

    const beginAction = (kind: Action['kind']): Action | null => {
        if (!ownerKey || activeOwnerKeyRef.current !== ownerKey) return null
        if (activeActionRef.current?.ownerKey === ownerKey) return null
        const action = { ownerKey, generation: generationRef.current, token: Symbol(kind), kind }
        activeActionRef.current = action
        setBusy(action)
        return action
    }
    const ownsAction = (action: Action) => (
        activeOwnerKeyRef.current === action.ownerKey
        && generationRef.current === action.generation
        && activeActionRef.current?.token === action.token
    )
    const finishAction = (action: Action) => {
        if (activeActionRef.current?.token !== action.token) return
        activeActionRef.current = null
        setBusy((current) => current?.token === action.token ? null : current)
    }

    const handleCreateMockRoom = async () => {
        if (!options.leagueId || !options.memberId || stateOwnerKey !== ownerKey) return
        const scheduledAt = parseLeagueDateTime(roomScheduledAt, timezone)?.toISOString()
        if (!scheduledAt) {
            showAlert('Invalid start time', 'Use a date and time like 2026-07-01 19:30.')
            return
        }
        const action = beginAction('create')
        if (!action) return
        try {
            await createMockDraftRoom({
                leagueId: options.leagueId,
                memberId: options.memberId,
                draftType: roomDraftType,
                roomName,
                scheduledAt,
                nominationOrderMode: mockNominationMode,
                timerSeconds: mockDraftTimerSeconds,
                rounds: mockRookieRounds,
                timerExpiryBehavior: mockRookieTimerExpiryBehavior,
            })
            if (!ownsAction(action)) return
            setRoomName('')
            setRoomScheduledAt(defaultRoomDateInput(timezone))
            await options.refreshRooms()
            return ownsAction(action)
        } catch (error) {
            if (ownsAction(action)) {
                showAlert('Could not create room', error instanceof Error ? error.message : undefined)
            }
        } finally {
            finishAction(action)
        }
    }

    const runRoomAction = async (
        operation: (isCurrent: () => boolean) => Promise<void>,
        errorTitle: string,
    ) => {
        const action = beginAction('room')
        if (!action) return
        try {
            await operation(() => ownsAction(action))
        } catch (error) {
            if (ownsAction(action)) showAlert(errorTitle, error instanceof Error ? error.message : undefined)
        } finally {
            finishAction(action)
        }
    }

    const ownsState = stateOwnerKey === ownerKey
    const ownsBusy = busy?.ownerKey === ownerKey

    return {
        handleCreateMockRoom,
        handleJoinMockRoom: (room: MockDraftRoom) => runRoomAction(async (isCurrent) => {
            if (!options.memberId) return
            await joinMockDraftRoom(room.id, options.memberId)
            if (isCurrent()) await options.refreshRooms()
        }, 'Could not join room'),
        handleLeaveMockRoom: (room: MockDraftRoom) => runRoomAction(async (isCurrent) => {
            if (!options.memberId) return
            await leaveMockDraftRoom(room.id, options.memberId)
            if (isCurrent()) await options.refreshRooms()
        }, 'Could not leave room'),
        handleDeleteMockRoom: (room: MockDraftRoom) => runRoomAction(async (isCurrent) => {
            if (!options.memberId) return
            await deleteMockDraftRoom(room.id, options.memberId)
            if (isCurrent()) await options.refreshRooms()
        }, 'Could not delete room'),
        handleStartMockRoom: (room: MockDraftRoom) => runRoomAction(async (isCurrent) => {
            if (!options.memberId) return
            const draft = await startMockDraftRoom(room.id, options.memberId)
            if (isCurrent()) options.openDraftRoom(draft.id, room.draftType)
        }, 'Could not start room'),
        roomActionLoading: Boolean(ownsBusy && busy?.kind === 'room'),
        roomDraftType: ownsState ? roomDraftType : 'auction',
        roomName: ownsState ? roomName : '',
        roomScheduledAt: ownsState ? roomScheduledAt : '',
        roomSubmitting: Boolean(ownsBusy && busy?.kind === 'create'),
        mockNominationMode,
        setMockNominationMode,
        mockDraftTimerSeconds,
        setMockDraftTimerSeconds,
        mockRookieRounds,
        setMockRookieRounds,
        mockRookieTimerExpiryBehavior,
        setMockRookieTimerExpiryBehavior,
        setRoomDraftType: changeRoomDraftType,
        setRoomName,
        setRoomScheduledAt,
    }
}
