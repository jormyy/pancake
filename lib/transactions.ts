import { supabase } from '@/lib/supabase'

export type TransactionRow = {
    id: string
    memberId: string
    teamName: string
    playerId: string
    playerName: string
    position: string | null
    nbaId: string | null
    transactionType: string
    occurredAt: string
}

export const TRANSACTION_LABELS: Record<string, string> = {
    fa_add: 'Added',
    fa_drop: 'Dropped',
    waiver_add: 'Claimed',
    waiver_drop: 'Dropped',
    trade_in: 'Acquired via Trade',
    trade_out: 'Traded Away',
    ir_designate: 'Placed on IR',
    ir_return: 'Activated from IR',
    draft_won: 'Drafted',
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
    const { error } = await (supabase as any).from('roster_transactions').insert({
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
): Promise<TransactionRow[]> {
    const { data: season } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()

    if (!season) return []

    const { data, error } = await (supabase as any)
        .from('roster_transactions')
        .select(`
            id,
            member_id,
            player_id,
            transaction_type,
            occurred_at,
            league_members!roster_transactions_member_id_fkey ( team_name ),
            players!roster_transactions_player_id_fkey ( display_name, position, nba_id )
        `)
        .eq('league_id', leagueId)
        .eq('league_season_id', (season as any).id)
        .in('transaction_type', ['fa_add', 'fa_drop', 'waiver_add', 'waiver_drop', 'trade_in', 'trade_out', 'draft_won'])
        .order('occurred_at', { ascending: false })
        .limit(limit)

    if (error) throw error

    return (data ?? []).map((row: any) => ({
        id: row.id,
        memberId: row.member_id,
        teamName: row.league_members?.team_name ?? 'Unknown',
        playerId: row.player_id,
        playerName: row.players?.display_name ?? 'Unknown',
        position: row.players?.position ?? null,
        nbaId: row.players?.nba_id ?? null,
        transactionType: row.transaction_type,
        occurredAt: row.occurred_at,
    }))
}
