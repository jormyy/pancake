import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'
import { notifyMember } from '../lib/notifications'

type PickAsset = { pickId: string; currentOwnerId: string }
type PickAssetMap = Map<string, PickAsset>

// Build a map keyed by `${original_owner_id}:${round}` -> current pick asset,
// so traded picks can be resolved to the current owner during slot assignment.
async function fetchPickAssetMap(leagueId: string, seasonYear: number | undefined): Promise<PickAssetMap> {
    // season_year may be undefined when reseeding a draft whose league_seasons
    // join returns null. The original implementation passed `undefined` to .eq();
    // we cast here to preserve that exact runtime behavior without re-introducing
    // an `as any` on the caller.
    const { data: draftPickAssets } = await supabase
        .from('draft_picks')
        .select('id, season_year, round, original_owner_id, current_owner_id')
        .eq('league_id', leagueId)
        .eq('season_year', seasonYear as number)
        .eq('is_used', false)
        .order('round', { ascending: true })

    const pickAssetMap: PickAssetMap = new Map()
    for (const dp of draftPickAssets ?? []) {
        const key = `${dp.original_owner_id}:${dp.round}`
        if (!pickAssetMap.has(key)) {
            pickAssetMap.set(key, { pickId: dp.id, currentOwnerId: dp.current_owner_id })
        }
    }
    return pickAssetMap
}

// Generate serpentine (snake) pick rows: odd rounds use draftOrder as-is,
// even rounds reverse it. Traded picks resolve to the current owner.
function buildSnakePickRows(
    draftId: string,
    draftOrder: string[],
    pickAssetMap: PickAssetMap,
    rounds: number,
) {
    const pickRows = []
    let overall = 1
    for (let round = 1; round <= rounds; round++) {
        const isEvenRound = round % 2 === 0
        const order = isEvenRound ? [...draftOrder].reverse() : draftOrder
        for (let i = 0; i < order.length; i++) {
            const originalOwner = order[i]
            const pickAsset = pickAssetMap.get(`${originalOwner}:${round}`)
            const member_id = pickAsset?.currentOwnerId ?? originalOwner
            pickRows.push({
                draft_id: draftId,
                overall_pick: overall++,
                round,
                pick_in_round: i + 1,
                member_id,
                draft_pick_id: pickAsset?.pickId ?? null,
            })
        }
    }
    return pickRows
}

// ── Start Rookie Draft (snake format) ─────────────────────────
export async function startRookieDraft(leagueId: string) {
    const { data: league, error: leagueErr } = await supabase
        .from('leagues')
        .select('id, status')
        .eq('id', leagueId)
        .single()
    if (leagueErr || !league) throw new Error('League not found')
    if (league.status !== 'offseason') throw new Error('League must be in offseason to start rookie draft')

    const { data: season, error: seasonErr } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (seasonErr || !season) throw new Error('No active season for this league')

    const { data: existing } = await supabase
        .from('drafts')
        .select('id, status')
        .eq('league_id', leagueId)
        .eq('league_season_id', season.id)
        .eq('draft_type', 'snake')
        .in('status', ['pending', 'in_progress'])
        .maybeSingle()
    if (existing) throw new Error('A rookie draft already exists for this season')

    // Draft order = inverse standings from last season (worst record picks first)
    // Fetch last completed season
    const { data: lastSeason } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', false)
        .order('season_year', { ascending: false })
        .limit(1)
        .maybeSingle()

    let draftOrder: string[] = []

    if (lastSeason) {
        // Get last week's standings from previous season.
        // The standings table is an append-only weekly snapshot written by
        // insertStandingsSnapshots, which only accumulates regular_season
        // matchup results (see backend/src/sync/scores.ts). Playoff weeks
        // carry forward the prior week's totals unchanged, so "latest"
        // standings here correctly reflects final regular-season records.
        const { data: standings } = await supabase
            .from('standings')
            .select('member_id, wins, losses, points_for')
            .eq('league_id', leagueId)
            .eq('league_season_id', lastSeason.id)
            .order('week_number', { ascending: false })
            .limit(100)

        if (standings && standings.length > 0) {
            // Deduplicate — keep only latest entry per member
            const latestByMember = new Map<string, typeof standings[0]>()
            for (const s of standings) {
                if (!latestByMember.has(s.member_id)) latestByMember.set(s.member_id, s)
            }
            // Sort worst to best: fewest wins, then fewest points
            draftOrder = Array.from(latestByMember.values())
                .sort((a, b) => a.wins - b.wins || a.points_for - b.points_for)
                .map((s) => s.member_id)
        }
    }

    // Fall back to current members in random order if no standings
    if (draftOrder.length === 0) {
        const { data: members } = await supabase
            .from('league_members')
            .select('id')
            .eq('league_id', leagueId)
        draftOrder = (members ?? []).map((m) => m.id).sort(() => Math.random() - 0.5)
    }

    if (draftOrder.length < 2) throw new Error('Need at least 2 managers to start a draft')

    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .insert({
            league_id: leagueId,
            league_season_id: season.id,
            draft_type: 'snake',
            status: 'in_progress',
            started_at: new Date().toISOString(),
        })
        .select()
        .single()
    if (draftErr) throw draftErr

    // Create draft_orders rows
    const orderRows = draftOrder.map((memberId, i) => ({
        draft_id: draft.id,
        member_id: memberId,
        position: i + 1,
    }))
    await supabase.from('draft_orders').insert(orderRows)

    // Build a map of the exact current-season pick asset for each original owner/round
    // so that traded picks are reflected in this draft's slot assignments.
    const pickAssetMap = await fetchPickAssetMap(leagueId, season.season_year)

    // Create snake_draft_picks
    const pickRows = buildSnakePickRows(draft.id, draftOrder, pickAssetMap, CONFIG.ROOKIE_DRAFT_ROUNDS)
    await supabase.from('snake_draft_picks').insert(pickRows)

    await supabase.from('leagues').update({ status: 'drafting' }).eq('id', leagueId)

    console.log(`[rookieDraft] Started snake draft ${draft.id} for league ${leagueId}`)
    return draft
}

// ── Make a Pick ────────────────────────────────────────────────
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

// ── Auto-pick best available player (used when pick clock expires) ────────
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
        .order('nba_draft_number', { ascending: true })
        .limit(100)

    const best = (players ?? []).find((p) => !pickedIds.has(p.id))
    if (!best) throw new Error('No available players for auto-pick')

    return makeSnakePick(draftId, memberId, best.id)
}

// ── Reseed picks for an in-progress draft (fixes traded-pick ownership) ───
export async function reseedRookieDraftPicks(draftId: string) {
    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .select('id, league_id, league_season_id, status, league_seasons ( season_year )')
        .eq('id', draftId)
        .single()
    if (draftErr || !draft) throw new Error('Draft not found')
    if (draft.status !== 'in_progress') throw new Error('Draft is not in progress')

    // Ensure no picks have been made yet
    const { count: madeCount } = await supabase
        .from('snake_draft_picks')
        .select('id', { count: 'exact', head: true })
        .eq('draft_id', draftId)
        .not('player_id', 'is', null)
    if ((madeCount ?? 0) > 0) throw new Error('Cannot reseed — picks have already been made')

    // Get the draft order (already saved in draft_orders)
    const { data: orders, error: ordersErr } = await supabase
        .from('draft_orders')
        .select('position, member_id')
        .eq('draft_id', draftId)
        .order('position')
    if (ordersErr || !orders?.length) throw new Error('Draft orders not found')
    const draftOrder = orders.map((o) => o.member_id)

    // Build exact pick-asset map from current draft_picks trade assets.
    const pickAssetMap = await fetchPickAssetMap(draft.league_id, draft.league_seasons?.season_year)

    // Delete existing picks and re-insert with correct ownership
    await supabase.from('snake_draft_picks').delete().eq('draft_id', draftId)

    const pickRows = buildSnakePickRows(draftId, draftOrder, pickAssetMap, CONFIG.ROOKIE_DRAFT_ROUNDS)
    await supabase.from('snake_draft_picks').insert(pickRows)
    console.log(`[rookieDraft] Reseeded ${pickRows.length} picks for draft ${draftId}`)
    return { reseeded: pickRows.length }
}

// ── Get Rookie Draft State ─────────────────────────────────────
export async function getRookieDraftState(draftId: string) {
    const [{ data: draft }, { data: picks }, { data: orders }] = await Promise.all([
        supabase
            .from('drafts')
            .select('id, league_id, league_season_id, status, started_at, completed_at')
            .eq('id', draftId)
            .single(),
        supabase
            .from('snake_draft_picks')
            .select(
                `overall_pick, round, pick_in_round, member_id, picked_at, player_id,
         players ( id, display_name, nba_team, position ),
         league_members ( team_name )`,
            )
            .eq('draft_id', draftId)
            .order('overall_pick'),
        supabase
            .from('draft_orders')
            .select('position, member_id, league_members ( team_name )')
            .eq('draft_id', draftId)
            .order('position'),
    ])

    if (!draft) return null

    const nextPick = (picks ?? []).find((p) => !p.player_id) ?? null

    return { draft, picks, orders, nextPick }
}
