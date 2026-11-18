import { supabase } from '@/lib/supabase'
import { apiPost } from '@/lib/shared/api'
import { assertMutationOnline, withPwaMutation } from '@/lib/shared/pwa-mutation'

export type LineupPin = 'start' | 'bench' | null

type PinResult = { playerId: string; date: string; lineupPin: LineupPin }
type PinRpc = {
    rpc: (name: 'set_lineup_player_pin', args: {
        p_league_id: string
        p_player_id: string
        p_date: string
        p_pin: LineupPin
    }) => PromiseLike<{ data: PinResult | null; error: { message: string } | null }>
}

export async function setLineupPlayerPin(leagueId: string, playerId: string, date: string, pin: LineupPin): Promise<PinResult> {
    assertMutationOnline()
    return withPwaMutation('setLineupPlayerPin', async () => {
        const { data, error } = await (supabase as unknown as PinRpc).rpc('set_lineup_player_pin', {
            p_league_id: leagueId, p_player_id: playerId, p_date: date, p_pin: pin,
        })
        if (error) throw error
        if (!data) throw new Error('Could not save lineup pin.')
        return data
    })
}

export async function optimizeLineupDate(memberId: string, leagueId: string, seasonId: string, date: string): Promise<void> {
    assertMutationOnline()
    const result = await apiPost<{ failed?: number; results?: { status: string; error?: string }[] }>(
        '/league/lineup/auto-set-season',
        { memberId, leagueId, leagueSeasonId: seasonId, dates: [date] },
    )
    const failure = result.results?.find(row => row.status === 'failed')
    if (result.failed || failure) throw new Error(failure?.error ?? 'Could not update the lineup for this day.')
}
