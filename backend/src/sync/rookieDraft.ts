import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'
import { notifyMember } from '../lib/notifications'
import type { Database } from '../types/database'

type DraftRow = Database['public']['Tables']['drafts']['Row']

export async function startRookieDraft(leagueId: string) {
    const { data, error } = await supabase.rpc('start_rookie_draft_atomic', {
        p_league_id: leagueId,
        p_rounds: CONFIG.ROOKIE_DRAFT_ROUNDS,
    })
    if (error) throw new Error(error.message)

    const draft = data as DraftRow
    console.log(`[rookieDraft] Started snake draft ${draft.id} for league ${leagueId}`)
    return draft
}

// All correctness-critical writes (validate next-pick / not-on-roster /
// not-already-picked, write snake_draft_picks, insert roster_players, mark
// draft_picks used, and on the last pick mark drafts.completed +
// leagues.status='active') run inside the SECURITY DEFINER
// `make_snake_pick_atomic` RPC (migration 20260516222106). The RPC takes a
// pg_advisory_xact_lock on (draft_id, 0) plus the standard
// (league_id, player_id) lock, locks the next null pick row FOR UPDATE,
// re-validates, and writes everything in one transaction — closing the race
// where two concurrent submits (manual + auto-pick, or a double-tap with
// different payloads) could clobber the same snake_draft_picks row while
// both INSERTed into roster_players.
//
// The TS side keeps the post-pick non-critical UI work (overflow / taxi /
// notification) since those don't affect persisted state.
export async function makeSnakePick(draftId: string, memberId: string, playerId: string) {
    const { data: rpcData, error: rpcError } = await supabase.rpc('make_snake_pick_atomic', {
        p_draft_id: draftId,
        p_member_id: memberId,
        p_player_id: playerId,
    })
    if (rpcError) {
        // Surface the RPC error message so the route handler returns the
        // same human-readable text the prior throws produced (e.g.
        // "It's not your pick", "Player is already on a roster", etc.).
        throw new Error(rpcError.message)
    }

    // The RPC returns JSONB built from jsonb_build_object — supabase-js
    // delivers it as a parsed object. Cast to the shape we expect.
    const result = rpcData as {
        pick: {
            id: string
            overall_pick: number
            round: number
            pick_in_round: number
            member_id: string
            draft_pick_id: string | null
        }
        remaining: number
        completed: boolean
        league_id: string
        league_season_id: string
    }

    if (result.completed) {
        console.log(`[rookieDraft] Draft ${draftId} completed`)
    }

    // Post-pick non-critical work: roster overflow + taxi count + push
    // notification. These read fresh state (the RPC already committed) so
    // races here only affect UI hints, not persistence.
    const { data: leagueRow } = await supabase
        .from('leagues')
        .select('roster_size, taxi_slots')
        .eq('id', result.league_id)
        .single()

    const rosterSize = leagueRow?.roster_size ?? CONFIG.DEFAULT_ROSTER_SIZE
    const taxiSlots = leagueRow?.taxi_slots ?? CONFIG.DEFAULT_TAXI_SLOTS

    const [{ count: activeCount }, { count: taxiCount }] = await Promise.all([
        supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', memberId)
            .eq('league_season_id', result.league_season_id)
            .eq('is_on_ir', false)
            .eq('is_on_taxi', false),
        supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', memberId)
            .eq('league_season_id', result.league_season_id)
            .eq('is_on_taxi', true),
    ])

    const { data: pickedPlayer } = await supabase
        .from('players')
        .select('display_name')
        .eq('id', playerId)
        .single()
    await notifyMember(
        memberId,
        'Rookie Draft Pick Made',
        `${pickedPlayer?.display_name ?? 'A player'} has been added to your roster.`,
        {
            draftId,
            playerId,
            pickId: result.pick.id,
            overallPick: result.pick.overall_pick,
            round: result.pick.round,
        },
    ).catch(console.error)

    return {
        pick: result.pick,
        remaining: result.remaining,
        rosterOverflow: (activeCount ?? 0) > rosterSize,
        taxiSlotsAvailable: (taxiCount ?? 0) < taxiSlots,
        newPlayerId: playerId,
    }
}

export async function autoPickBest(draftId: string, memberId: string) {
    // Get already-picked player IDs for this draft
    const { data: pickedRows } = await supabase
        .from('snake_draft_picks')
        .select('player_id')
        .eq('draft_id', draftId)
        .not('player_id', 'is', null)
    const pickedIds = new Set((pickedRows ?? []).map((r) => r.player_id))

    // Best available = lowest nba_draft_number not yet picked
    const { data: players } = await supabase
        .from('players')
        .select('id')
        .not('nba_draft_number', 'is', null)
        .eq('years_exp', 0)
        .order('nba_draft_number', { ascending: true })
        .order('id', { ascending: true })
        .limit(100)

    const best = (players ?? []).find((p) => !pickedIds.has(p.id))
    if (!best) throw new Error('No available players for auto-pick')

    return makeSnakePick(draftId, memberId, best.id)
}

export async function reseedRookieDraftPicks(draftId: string) {
    const { data, error } = await supabase.rpc('reseed_rookie_draft_picks_atomic', {
        p_draft_id: draftId,
        p_rounds: CONFIG.ROOKIE_DRAFT_ROUNDS,
    })
    if (error) throw new Error(error.message)

    const reseeded = Number(data ?? 0)
    console.log(`[rookieDraft] Reseeded ${reseeded} picks for draft ${draftId}`)
    return { reseeded }
}

// Rookie draft state is read client-side via RLS-scoped Supabase queries
// (lib/rookieDraft.ts). The former service-role backend reader + its GET route
// were removed to avoid leaking private draft state across leagues.
