import { isIREligible } from '@pancake/core'
import { supabase } from '../lib/supabase'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'

function isTaxiEligible(nbaDraftNumber: number | null): boolean {
    return nbaDraftNumber != null
}

async function fetchRosterPlacementContext(rosterPlayerId: string, userId: string) {
    const { data: rp, error: rpError } = await supabase
        .from('roster_players')
        .select(`
            member_id,
            league_id,
            league_season_id,
            player_id,
            is_on_ir,
            is_on_taxi,
            players ( injury_status, nba_draft_number )
        `)
        .eq('id', rosterPlayerId)
        .single()

    if (rpError || !rp) {
        throw new NotFoundError('Roster player not found')
    }

    // member lookup (for auth) and league lookup are both keyed off rp and independent of each other.
    const [memberRes, leagueRes] = await Promise.all([
        supabase
            .from('league_members')
            .select('user_id')
            .eq('id', rp.member_id)
            .single(),
        supabase
            .from('leagues')
            .select('roster_size, ir_slots, taxi_slots')
            .eq('id', rp.league_id)
            .single(),
    ])

    const member = memberRes.data
    if (!member || member.user_id !== userId) {
        throw new AppError('Not authorized to modify this roster', 403)
    }

    const league = leagueRes.data

    return {
        rp: rp as any,
        league: league as { roster_size: number | null; ir_slots: number | null; taxi_slots: number | null } | null,
    }
}

async function activeRosterCount(memberId: string, seasonId: string): Promise<number> {
    const { count, error } = await supabase
        .from('roster_players')
        .select('id', { count: 'exact', head: true })
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .eq('is_on_ir', false)
        .eq('is_on_taxi', false)

    if (error) {
        throw new AppError(error.message, 500)
    }
    return count ?? 0
}

async function clearLineupsForRosterPlayer(rp: any) {
    const { error: delError } = await supabase
        .from('weekly_lineups')
        .delete()
        .eq('member_id', rp.member_id)
        .eq('league_id', rp.league_id)
        .eq('league_season_id', rp.league_season_id)
        .eq('player_id', rp.player_id)

    if (delError) {
        console.error('Failed to clear lineups on roster placement change', delError)
    }
}

async function logRosterPlacement(rp: any, transactionType: string) {
    await (supabase as any).from('roster_transactions').insert({
        league_id: rp.league_id,
        league_season_id: rp.league_season_id,
        member_id: rp.member_id,
        player_id: rp.player_id,
        transaction_type: transactionType,
    }).then(({ error }: any) => {
        if (error) console.error('[roster placement log]', error)
    })
}

export async function toggleIRStatus(
    rosterPlayerId: string,
    isOnIR: boolean,
    userId: string,
): Promise<void> {
    const { rp, league } = await fetchRosterPlacementContext(rosterPlayerId, userId)
    const rosterSize = league?.roster_size ?? 20
    const irSlots = league?.ir_slots ?? 2

    if (isOnIR) {
        if (!isIREligible(rp.players?.injury_status ?? null)) {
            throw new ValidationError('Only players with Out or IR designations can be placed on IR.')
        }

        const { count } = await supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', rp.member_id)
            .eq('league_season_id', rp.league_season_id)
            .eq('is_on_ir', true)
            .neq('id', rosterPlayerId)
        if ((count ?? 0) >= irSlots) {
            throw new ValidationError(`You only have ${irSlots} IR slot${irSlots === 1 ? '' : 's'}.`)
        }
    } else {
        const activeCount = await activeRosterCount(rp.member_id, rp.league_season_id)
        if (activeCount >= rosterSize) {
            throw new ValidationError(`Your active roster is full (${rosterSize} players).`)
        }
    }

    const { error } = await supabase
        .from('roster_players')
        .update({ is_on_ir: isOnIR, is_on_taxi: isOnIR ? false : rp.is_on_taxi })
        .eq('id', rosterPlayerId)
    if (error) throw new AppError(error.message, 500)

    // Side effects target different tables and both swallow their own errors, so run in parallel.
    await Promise.all([
        isOnIR ? clearLineupsForRosterPlayer(rp) : Promise.resolve(),
        logRosterPlacement(rp, isOnIR ? 'ir_designate' : 'ir_return'),
    ])
}

export async function toggleTaxiStatus(
    rosterPlayerId: string,
    isOnTaxi: boolean,
    userId: string,
): Promise<void> {
    const { rp, league } = await fetchRosterPlacementContext(rosterPlayerId, userId)
    const rosterSize = league?.roster_size ?? 20
    const taxiSlots = league?.taxi_slots ?? 0

    if (isOnTaxi) {
        if (rp.is_on_ir) {
            throw new ValidationError('Activate the player from IR before moving them to taxi.')
        }
        if (!isTaxiEligible(rp.players?.nba_draft_number ?? null)) {
            throw new ValidationError('Only rookies can be placed on the taxi squad.')
        }

        const { count } = await supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', rp.member_id)
            .eq('league_season_id', rp.league_season_id)
            .eq('is_on_taxi', true)
            .neq('id', rosterPlayerId)
        if ((count ?? 0) >= taxiSlots) {
            throw new ValidationError(`You only have ${taxiSlots} taxi squad slot${taxiSlots === 1 ? '' : 's'}.`)
        }
    } else {
        const activeCount = await activeRosterCount(rp.member_id, rp.league_season_id)
        if (activeCount >= rosterSize) {
            throw new ValidationError(`Your active roster is full (${rosterSize} players).`)
        }
    }

    const { error } = await supabase
        .from('roster_players')
        .update({ is_on_taxi: isOnTaxi })
        .eq('id', rosterPlayerId)

    if (error) {
        throw new AppError(error.message, 500)
    }

    // Side effects target different tables and both swallow their own errors, so run in parallel.
    await Promise.all([
        isOnTaxi ? clearLineupsForRosterPlayer(rp) : Promise.resolve(),
        logRosterPlacement(rp, isOnTaxi ? 'taxi_designate' : 'taxi_return'),
    ])
}
