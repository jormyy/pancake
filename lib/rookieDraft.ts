import { validateRookieTimerSeconds } from '@/lib/draft-options'
import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'
import { apiPost as sharedApiPost } from '@/lib/shared/api'
import type { RookieTimerExpiryBehavior } from '@/lib/draft'
import { subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

export type SnakePick = {
    overallPick: number
    round: number
    pickInRound: number
    memberId: string
    teamName: string
    pickedAt: string | null
    skippedAt: string | null
    skipReason: string | null
    timerExpiresAt: string | null
    player: {
        id: string
        displayName: string
        nbaTeam: string | null
        position: string | null
        nbaId: string | null
        yearsExp?: number | null
        careerGames?: number | null
        injuryStatus?: string | null
    } | null
}

export type RookieDraftState = {
    draft: {
        id: string
        leagueId: string
        leagueSeasonId: string
        seasonYear?: number
        isCurrentSeason: boolean
        status: string
        isMock: boolean
        pickTimerSeconds: number
        timerExpiryBehavior: RookieTimerExpiryBehavior
        rounds: number | null
        startedAt: string | null
        completedAt: string | null
        pauseReason: string | null
        pausedAt: string | null
        pausedRemainingSeconds: number | null
    }
    picks: SnakePick[]
    orders: { position: number; memberId: string; teamName: string }[]
    nextPick: SnakePick | null
}

export type RookieProspect = {
    injury_status?: string | null
    years_exp?: number | null
    career_regular_season_games?: number | null
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    nba_id: string | null
    nba_draft_number: number | null
}

export type LeaguePickItem = {
    id: string
    seasonYear: number
    round: number
    isUsed: boolean
    originalOwnerMemberId: string
    originalTeamName: string
    currentOwnerMemberId: string
    currentTeamName: string
}

export type RookieDraftStartOptions = {
    isMock?: boolean
    timerSeconds?: number
    rounds?: number
    timerExpiryBehavior?: RookieTimerExpiryBehavior
}

export async function getActiveRookieDraft(leagueId: string) {
    const { data } = await supabase
        .from('drafts')
        .select('id, league_id, status, draft_type, is_mock, pick_timer_seconds, timer_expiry_behavior, rounds, started_at, pause_reason, paused_at, timer_paused_remaining_seconds')
        .eq('league_id', leagueId)
        .eq('draft_type', 'snake')
        .eq('is_mock', false)
        .in('status', ['in_progress', 'pending', 'paused'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data
}

export async function activateRookieDraftLeague(draftId: string): Promise<boolean> {
    const result = await sharedApiPost<{ activated?: boolean }>(`/draft/${draftId}/activate-rookie-league`, {})
    return Boolean(result?.activated)
}

export type RookieStartWarning = {
    code: 'opening_night_unpublished' | 'opening_night_overrun' | null
    openingNightCutoff: string | null
    estimatedFinishAt: string
    remainingPicks: number
    timerSeconds: number
}

export async function getRookieStartWarning(leagueId: string, options: RookieDraftStartOptions = {}) {
    const result = await sharedApiPost<{ warning: RookieStartWarning }>('/draft/rookie-start-warning', {
        leagueId,
        timerSeconds: validateRookieTimerSeconds(options.timerSeconds ?? 60),
        rounds: options.rounds ?? 3,
    })
    return result.warning
}

export async function startRookieDraft(leagueId: string, options: RookieDraftStartOptions = {}) {
    validateRookieTimerSeconds(options.timerSeconds ?? 60)
    const result = await sharedApiPost<{ draft: { id: string; draft_type: 'snake' } }>('/draft/start-rookie', {
        leagueId,
        isMock: options.isMock === true,
        ...(options.timerSeconds != null ? { timerSeconds: options.timerSeconds } : {}),
        ...(options.rounds != null ? { rounds: options.rounds } : {}),
        ...(options.timerExpiryBehavior ? { timerExpiryBehavior: options.timerExpiryBehavior } : {}),
    })
    return { draft: { id: result.draft.id, draftType: result.draft.draft_type } }
}

export async function makeSnakePick(draftId: string, memberId: string, playerId: string, toTaxi = false) {
    return sharedApiPost<any>(`/draft/${draftId}/snake-pick`, { memberId, playerId, toTaxi })
}

export async function commissionerSnakePick(draftId: string, memberId: string, playerId: string, toTaxi = false) {
    return sharedApiPost<any>(`/draft/${draftId}/commissioner-pick`, { memberId, playerId, toTaxi })
}

export async function processExpiredSnakePick(draftId: string, memberId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/process-expired-pick`, { memberId })
}

export async function reseedRookieDraftPicks(draftId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/reseed-picks`, {})
}

export async function advanceSeason(leagueId: string) {
    return sharedApiPost<any>('/league/advance-season', { leagueId })
}

export function subscribeToRookieDraft(draftId: string, onChange: () => void, onReconnect?: () => Promise<boolean>): RealtimeChannel {
    return subscribeToTableChanges(`rookie-draft:${draftId}`, {
        mode: 'fallback',
        watches: [
            { table: 'snake_draft_picks', filter: `draft_id=eq.${draftId}` },
            { table: 'drafts', event: 'UPDATE', filter: `id=eq.${draftId}` },
        ],
        onChange,
        onReconnect,
    })
}

export async function unsubscribeFromRookieDraft(channel: RealtimeChannel): Promise<void> {
    await unsubscribeFromTableChanges(channel)
}
