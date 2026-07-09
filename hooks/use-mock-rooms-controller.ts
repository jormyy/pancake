import { useState } from 'react'
import {
    createMockDraftRoom,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
} from '@/lib/mockDraftRooms'
import type { NominationOrderMode, RookieTimerExpiryBehavior } from '@/lib/draft'
import type { DraftTimerOption, RookieRoundOption } from '@/components/league/DraftChips'
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
    const [roomName, setRoomName] = useState('')
    const [roomDraftType, setRoomDraftType] = useState<MockDraftRoomKind>('auction')
    const [roomScheduledAt, setRoomScheduledAt] = useState(defaultRoomDateInput)
    const [roomSubmitting, setRoomSubmitting] = useState(false)
    const [roomActionLoading, setRoomActionLoading] = useState(false)

    const handleCreateMockRoom = async () => {
        if (!options.leagueId || !options.memberId) return
        const scheduledAt = parseRoomDateInput(roomScheduledAt)
        if (!scheduledAt) {
            showAlert('Invalid start time', 'Use a date and time like 2026-07-01 19:30.')
            return
        }
        setRoomSubmitting(true)
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
            setRoomName('')
            setRoomScheduledAt(defaultRoomDateInput())
            await options.refreshRooms()
        } catch (error) {
            showAlert('Could not create room', error instanceof Error ? error.message : undefined)
        } finally {
            setRoomSubmitting(false)
        }
    }

    const runRoomAction = async (action: () => Promise<void>, errorTitle: string) => {
        setRoomActionLoading(true)
        try {
            await action()
        } catch (error) {
            showAlert(errorTitle, error instanceof Error ? error.message : undefined)
        } finally {
            setRoomActionLoading(false)
        }
    }

    return {
        handleCreateMockRoom,
        handleJoinMockRoom: (room: MockDraftRoom) => runRoomAction(async () => {
            if (!options.memberId) return
            await joinMockDraftRoom(room.id, options.memberId)
            await options.refreshRooms()
        }, 'Could not join room'),
        handleLeaveMockRoom: (room: MockDraftRoom) => runRoomAction(async () => {
            if (!options.memberId) return
            await leaveMockDraftRoom(room.id, options.memberId)
            await options.refreshRooms()
        }, 'Could not leave room'),
        handleStartMockRoom: (room: MockDraftRoom) => runRoomAction(async () => {
            if (!options.memberId) return
            const draft = await startMockDraftRoom(room.id, options.memberId)
            options.openDraftRoom(draft.id, room.draftType)
        }, 'Could not start room'),
        roomActionLoading,
        roomDraftType,
        roomName,
        roomScheduledAt,
        roomSubmitting,
        setRoomDraftType,
        setRoomName,
        setRoomScheduledAt,
    }
}
