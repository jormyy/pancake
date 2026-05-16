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

export async function toggleIRStatus(
    rosterPlayerId: string,
    isOnIR: boolean,
    userId: string,
): Promise<void> {
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
    // Atomic counterpart to toggleIRStatus for the taxi squad. Same lock /
    // re-check / mutate pattern; rejects IR→taxi directly and gates taxi
    // designations to rookies (nba_draft_number IS NOT NULL).
    const { error } = await supabase.rpc('toggle_taxi_atomic', {
        p_roster_player_id: rosterPlayerId,
        p_to_taxi: isOnTaxi,
        p_user_id: userId,
    })

    if (error) throw mapToggleError(error)
}
