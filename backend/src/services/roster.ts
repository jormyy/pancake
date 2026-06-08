import { supabase } from '../lib/supabase'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'

// Translate a PostgREST/RPC error from toggle_ir_atomic or toggle_taxi_atomic
// into the same AppError subclass the prior inline implementation threw.
// Error codes map:
//   42501  → 403 AppError ("Not authorized…")
//   P0002  → 404 NotFoundError ("Roster player not found" / "League not found")
//   P0001  → 400 ValidationError (cap / eligibility messages)
//   23514  → 400 ValidationError (chk_not_ir_and_taxi etc — defensive)
//   *      → 500 AppError
function mapToggleError(error: { code?: string; message?: string }): Error {
    const message = error.message ?? 'Roster toggle failed'
    switch (error.code) {
        case '42501':
            return new AppError(message, 403)
        case 'P0002':
            return new NotFoundError(message)
        case 'P0001':
        case '23514':
            return new ValidationError(message)
        default:
            return new AppError(message, 500)
    }
}

function todayET(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date())
    const get = (type: string) => parts.find((part) => part.type === type)?.value
    return `${get('year')}-${get('month')}-${get('day')}`
}

async function assertRosterToggleUnlocked(
    rosterPlayerId: string,
    userId: string,
): Promise<void> {
    const gameDate = todayET()
    const { data: rosterPlayer, error: rosterError } = await supabase
        .from('roster_players')
        .select('id, players!inner(display_name, nba_team), league_members!inner(user_id)')
        .eq('id', rosterPlayerId)
        .maybeSingle()

    if (rosterError) throw mapToggleError(rosterError)
    if (!rosterPlayer) throw new NotFoundError('Roster player not found')
    if (rosterPlayer.league_members?.user_id !== userId) {
        throw new AppError('Not authorized to modify this roster player.', 403)
    }

    const team = rosterPlayer.players?.nba_team
    if (!team) return

    const now = new Date().toISOString()
    const { data: startedGame, error: gameError } = await supabase
        .from('nba_games')
        .select('id')
        .eq('game_date', gameDate)
        .or(`home_team.eq.${team},away_team.eq.${team}`)
        .or(`status.in.(InProgress,Final),game_time.lte.${now}`)
        .limit(1)
        .maybeSingle()

    if (gameError) throw mapToggleError(gameError)
    if (startedGame) {
        throw new ValidationError(`${rosterPlayer.players.display_name}'s game has already started. No roster status changes are allowed for that slate.`)
    }
}

export async function toggleIRStatus(
    rosterPlayerId: string,
    isOnIR: boolean,
    userId: string,
): Promise<void> {
    await assertRosterToggleUnlocked(rosterPlayerId, userId)
    // Atomic: lock the roster row + (league_id, player_id) advisory lock,
    // re-check IR-eligibility and IR-slot cap (or active-roster cap on
    // return) under the lock, UPDATE roster_players, DELETE weekly_lineups
    // when entering IR, INSERT roster_transactions audit row — all in a
    // single Postgres transaction. Replaces a pre-2026-05-16 select-then-
    // update path that allowed concurrent designates from two devices to
    // both pass the cap check and exceed the league's IR slot limit.
    const { error } = await supabase.rpc('toggle_ir_atomic', {
        p_roster_player_id: rosterPlayerId,
        p_to_ir: isOnIR,
        p_user_id: userId,
    })

    if (error) throw mapToggleError(error)
}

export async function toggleTaxiStatus(
    rosterPlayerId: string,
    isOnTaxi: boolean,
    userId: string,
): Promise<void> {
    await assertRosterToggleUnlocked(rosterPlayerId, userId)
    // Atomic counterpart to toggleIRStatus for the taxi squad. Same lock /
    // re-check / mutate pattern; rejects IR→taxi directly and gates taxi
    // designations to current rookies (nba_draft_number IS NOT NULL and years_exp = 0).
    const { error } = await supabase.rpc('toggle_taxi_atomic', {
        p_roster_player_id: rosterPlayerId,
        p_to_taxi: isOnTaxi,
        p_user_id: userId,
    })

    if (error) throw mapToggleError(error)
}
