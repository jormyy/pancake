import { useEffect, useRef, useState } from 'react'
import {
    createMockDraftRoom,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
} from '@/lib/mockDraftRooms'
import type { NominationOrderMode, RookieTimerExpiryBehavior } from '@/lib/draft'
import type { DraftTimerOption, RookieRoundOption } from '@/lib/draft-options'
import { showAlert } from '@/lib/alert'

function defaultRoomDateInput(): string {
    const date = new Date(Date.now() + 30 * 60 * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseRoomDateInput(value: string): string | null {
    const normalized = value.trim().replace(' ', 'T')
    if (!normalized) return null
    const parsed = new Date(normalized)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

type MockRoomControllerOptions = {
    leagueId: string | undefined
    memberId: string | undefined
    nominationMode: NominationOrderMode
    draftTimerSeconds: DraftTimerOption
    rookieRounds: RookieRoundOption
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior
    refreshRooms: () => Promise<void>
    openDraftRoom: (draftId: string, draftType: string) => void
}

export function useMockRoomsController(options: MockRoomControllerOptions) {
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
    const [roomScheduledAt, setRoomScheduledAt] = useState(defaultRoomDateInput)

    useEffect(() => {
        activeActionRef.current = null
        setBusy(null)
        setStateOwnerKey(ownerKey)
        setRoomName('')
        setRoomDraftType('auction')
        setRoomScheduledAt(defaultRoomDateInput())
        return () => {
            generationRef.current += 1
            activeActionRef.current = null
        }
    }, [ownerKey])

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
        const scheduledAt = parseRoomDateInput(roomScheduledAt)
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
                nominationOrderMode: options.nominationMode,
                timerSeconds: options.draftTimerSeconds,
                rounds: options.rookieRounds,
                timerExpiryBehavior: options.rookieTimerExpiryBehavior,
            })
            if (!ownsAction(action)) return
            setRoomName('')
            setRoomScheduledAt(defaultRoomDateInput())
            await options.refreshRooms()
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
        setRoomDraftType,
        setRoomName,
        setRoomScheduledAt,
    }
}
