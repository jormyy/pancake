import { supabase } from '@/lib/supabase'
import { getEligiblePositions } from '@/lib/players'

export { TRANSACTION_LABELS } from '@/lib/shared/transaction-labels'

export type TransactionRow = {
    id: string
    memberId: string | null
    targetMemberId?: string | null
    teamName: string
    targetTeamName?: string | null
    playerId: string | null
    playerName: string
    position: string | null
    eligiblePositions: string[]
    nbaId: string | null
    transactionType: string
    occurredAt: string
    isSystem?: boolean
    title?: string
    body?: string | null
}

export async function logTransaction(params: {
    leagueId: string
    leagueSeasonId: string
    memberId: string
    playerId: string
    transactionType: string
    relatedTradeId?: string | null
    relatedClaimId?: string | null
}): Promise<void> {
    const { error } = await supabase.from('roster_transactions').insert({
        league_id: params.leagueId,
        league_season_id: params.leagueSeasonId,
        member_id: params.memberId,
        player_id: params.playerId,
        transaction_type: params.transactionType,
        related_trade_id: params.relatedTradeId ?? null,
        related_claim_id: params.relatedClaimId ?? null,
    })
    if (error) console.error('[logTransaction]', error)
}

export async function getLeagueTransactions(
    leagueId: string,
    limit = 50,
    offset = 0,
): Promise<TransactionRow[]> {
    type FeedRow = {
        id: string
        member_id: string | null
        target_member_id: string | null
        team_name: string | null
        target_team_name: string | null
        player_id: string | null
        player_name: string | null
        player_position: string | null
        eligible_positions: string[] | null
        nba_id: string | null
        transaction_type: string
        occurred_at: string
        is_system: boolean
        title: string | null
        body: string | null
    }

    const { data, error } = await supabase.rpc('get_league_activity_feed', {
        p_league_id: leagueId,
        p_limit: limit,
        p_offset: offset,
    })
    if (error) throw error

    return ((data ?? []) as FeedRow[]).map((row) => ({
        id: row.id,
        memberId: row.member_id,
        targetMemberId: row.target_member_id,
        teamName: row.team_name ?? (row.is_system ? 'League' : 'Unknown'),
        targetTeamName: row.target_team_name,
        playerId: row.player_id,
        playerName: row.player_name ?? row.title ?? 'Unknown',
        position: row.player_position ?? null,
        eligiblePositions: getEligiblePositions(row),
        nbaId: row.nba_id ?? null,
        transactionType: row.transaction_type,
        occurredAt: row.occurred_at,
        isSystem: row.is_system,
        title: row.title ?? undefined,
        body: row.body ?? null,
    }))
}
