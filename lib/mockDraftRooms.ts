import { apiPost } from '@/lib/shared/api'
import type { Draft, NominationOrderMode, RookieTimerExpiryBehavior } from '@/lib/draft'

export type MockDraftRoomKind = 'auction' | 'snake'
export type MockDraftRoomStatus = 'active' | 'scheduled' | 'live' | 'completed'

type MockDraftRoomParticipant = {
    memberId: string
    teamName: string
    joinedAt: string
}

export type MockDraftRoom = {
    id: string
    leagueId: string
    draftType: MockDraftRoomKind
    status: string
    roomStatus: MockDraftRoomStatus
    roomName: string
    scheduledAt: string | null
    startedAt: string | null
    completedAt: string | null
    createdByMemberId: string | null
    creatorTeamName: string
    pickTimerSeconds: number
    rounds: number | null
    nominationOrderMode: NominationOrderMode
    timerExpiryBehavior: RookieTimerExpiryBehavior | 'auction_no_bid'
    participants: MockDraftRoomParticipant[]
    isJoined: boolean
    isCreator: boolean
}

type CreateMockDraftRoomOptions = {
    leagueId: string
    memberId: string
    draftType: MockDraftRoomKind
    roomName?: string
    scheduledAt?: string | null
    nominationOrderMode?: NominationOrderMode
    timerSeconds?: number
    budgetPerTeam?: number | null
    rounds?: number
    timerExpiryBehavior?: RookieTimerExpiryBehavior
}

export function getMockDraftRoomStatus(
    room: Pick<MockDraftRoom, 'status' | 'scheduledAt'>,
    now = Date.now(),
): MockDraftRoomStatus {
    if (room.status === 'in_progress' || room.status === 'paused') return 'live'
    if (room.status === 'completed' || room.status === 'cancelled') return 'completed'
    if (room.scheduledAt && Date.parse(room.scheduledAt) > now) return 'scheduled'
    return 'active'
}

export async function createMockDraftRoom(options: CreateMockDraftRoomOptions): Promise<Draft> {
    const response = await apiPost<{ draft: Draft }>('/draft/mock-room/create', {
        leagueId: options.leagueId,
        memberId: options.memberId,
        draftType: options.draftType,
        roomName: options.roomName,
        scheduledAt: options.scheduledAt,
        nominationOrderMode: options.nominationOrderMode,
        timerSeconds: options.timerSeconds,
        budgetPerTeam: options.budgetPerTeam,
        rounds: options.rounds,
        timerExpiryBehavior: options.timerExpiryBehavior,
    })
    return response.draft
}

export async function joinMockDraftRoom(draftId: string, memberId: string): Promise<void> {
    await apiPost(`/draft/${draftId}/join-mock-room`, { memberId })
}

export async function leaveMockDraftRoom(draftId: string, memberId: string): Promise<void> {
    await apiPost(`/draft/${draftId}/leave-mock-room`, { memberId })
}

export async function deleteMockDraftRoom(draftId: string, memberId: string): Promise<void> {
    await apiPost(`/draft/${draftId}/delete-mock-room`, { memberId })
}

export async function startMockDraftRoom(draftId: string, memberId: string): Promise<Draft> {
    const response = await apiPost<{ draft: Draft }>(`/draft/${draftId}/start-mock-room`, { memberId })
    return response.draft
}
