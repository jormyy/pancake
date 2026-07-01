import { supabase } from '@/lib/supabase'
import { apiPost } from '@/lib/shared/api'
import type { Draft, NominationOrderMode, RookieTimerExpiryBehavior } from '@/lib/draft'

export type MockDraftRoomKind = 'auction' | 'snake'
export type MockDraftRoomStatus = 'active' | 'scheduled' | 'live' | 'completed'

export type MockDraftRoomParticipant = {
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

type RoomDraftRow = {
    id: string
    league_id: string
    draft_type: MockDraftRoomKind
    status: string
    room_name: string | null
    scheduled_at: string | null
    started_at: string | null
    completed_at: string | null
    created_by_member_id: string | null
    pick_timer_seconds: number | null
    rounds: number | null
    nomination_order_mode: string | null
    timer_expiry_behavior: string | null
    created_by?: { team_name: string | null } | null
    draft_room_members?: Array<{
        member_id: string
        joined_at: string
        league_members?: { team_name: string | null } | null
    }>
}

export type CreateMockDraftRoomOptions = {
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

function roomStatus(row: RoomDraftRow, nowIso: string): MockDraftRoomStatus {
    if (row.status === 'in_progress' || row.status === 'paused') return 'live'
    if (row.status === 'completed' || row.status === 'cancelled') return 'completed'
    if (row.scheduled_at && row.scheduled_at > nowIso) return 'scheduled'
    return 'active'
}

function defaultRoomName(row: RoomDraftRow): string {
    if (row.room_name?.trim()) return row.room_name.trim()
    return row.draft_type === 'snake' ? 'Mock Rookie Draft' : 'Mock Auction'
}

function mapRoom(row: RoomDraftRow, currentMemberId: string, nowIso: string): MockDraftRoom {
    const participants = (row.draft_room_members ?? [])
        .map((member) => ({
            memberId: member.member_id,
            teamName: member.league_members?.team_name ?? 'Team',
            joinedAt: member.joined_at,
        }))
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.memberId.localeCompare(b.memberId))

    return {
        id: row.id,
        leagueId: row.league_id,
        draftType: row.draft_type,
        status: row.status,
        roomStatus: roomStatus(row, nowIso),
        roomName: defaultRoomName(row),
        scheduledAt: row.scheduled_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdByMemberId: row.created_by_member_id,
        creatorTeamName: row.created_by?.team_name ?? 'Team',
        pickTimerSeconds: row.pick_timer_seconds ?? 30,
        rounds: row.rounds,
        nominationOrderMode: (row.nomination_order_mode ?? 'user_nominated') as NominationOrderMode,
        timerExpiryBehavior: (row.timer_expiry_behavior ?? 'auto_pick') as RookieTimerExpiryBehavior | 'auction_no_bid',
        participants,
        isJoined: participants.some((member) => member.memberId === currentMemberId),
        isCreator: row.created_by_member_id === currentMemberId,
    }
}

export async function getMockDraftRooms(
    leagueId: string,
    currentMemberId: string,
): Promise<MockDraftRoom[]> {
    const { data, error } = await (supabase as any)
        .from('drafts')
        .select(`
            id, league_id, draft_type, status, room_name, scheduled_at, started_at, completed_at,
            created_by_member_id, pick_timer_seconds, rounds, nomination_order_mode, timer_expiry_behavior,
            created_by:league_members!drafts_created_by_member_id_fkey ( team_name ),
            draft_room_members (
                member_id,
                joined_at,
                league_members ( team_name )
            )
        `)
        .eq('league_id', leagueId)
        .eq('is_mock', true)
        .order('created_at', { ascending: false })
        .limit(60)

    if (error) throw error
    const nowIso = new Date().toISOString()
    return ((data ?? []) as RoomDraftRow[]).map((row) => mapRoom(row, currentMemberId, nowIso))
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

export async function startMockDraftRoom(draftId: string, memberId: string): Promise<Draft> {
    const response = await apiPost<{ draft: Draft }>(`/draft/${draftId}/start-mock-room`, { memberId })
    return response.draft
}
