import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'

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
        // Get last week's standings from previous season
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

    // Build a map of who currently owns each pick (original_owner_id:round -> current_owner_id)
    // so that traded picks are reflected in the draft slot assignments.
    // Use the earliest unused season_year picks — those represent the next draft class.
    const { data: draftPickAssets } = await supabase
        .from('draft_picks')
        .select('season_year, round, original_owner_id, current_owner_id')
        .eq('league_id', leagueId)
        .eq('is_used', false)
        .order('season_year', { ascending: true })

    const pickOwnerMap = new Map<string, string>()
    for (const dp of draftPickAssets ?? []) {
        const key = `${dp.original_owner_id}:${dp.round}`
        if (!pickOwnerMap.has(key)) pickOwnerMap.set(key, dp.current_owner_id)
    }

    // Create snake_draft_picks
    const pickRows = []
    let overall = 1
    for (let round = 1; round <= CONFIG.ROOKIE_DRAFT_ROUNDS; round++) {
        const isEvenRound = round % 2 === 0
        const order = isEvenRound ? [...draftOrder].reverse() : draftOrder
        for (let i = 0; i < order.length; i++) {
            const originalOwner = order[i]
            // If the pick was traded, use the current owner; otherwise keep original
            const member_id = pickOwnerMap.get(`${originalOwner}:${round}`) ?? originalOwner
            pickRows.push({
                draft_id: draft.id,
                overall_pick: overall++,
                round,
                pick_in_round: i + 1,
                member_id,
            })
        }
    }
    await supabase.from('snake_draft_picks').insert(pickRows)

    await supabase.from('leagues').update({ status: 'drafting' }).eq('id', leagueId)

    console.log(`[rookieDraft] Started snake draft ${draft.id} for league ${leagueId}`)
    return draft
}

// ── Make a Pick ────────────────────────────────────────────────
export async function makeSnakePick(draftId: string, memberId: string, playerId: string) {
    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .select('id, league_id, league_season_id, status')
        .eq('id', draftId)
        .single()
    if (draftErr || !draft) throw new Error('Draft not found')
    if (draft.status !== 'in_progress') throw new Error('Draft is not in progress')

    // Find the next unpicked slot
    const { data: nextPick, error: pickErr } = await supabase
        .from('snake_draft_picks')
        .select('id, overall_pick, round, pick_in_round, member_id')
        .eq('draft_id', draftId)
        .is('player_id', null)
        .order('overall_pick', { ascending: true })
        .limit(1)
        .single()
    if (pickErr || !nextPick) throw new Error('No picks remaining — draft may be complete')

    if (nextPick.member_id !== memberId) throw new Error("It's not your pick")

    // Check player not already on a roster in this season
    const { data: onRoster } = await supabase
        .from('roster_players')
        .select('id')
        .eq('league_id', draft.league_id)
        .eq('league_season_id', draft.league_season_id)
        .eq('player_id', playerId)
        .maybeSingle()
    if (onRoster) throw new Error('Player is already on a roster')

    // Check player not already picked in this draft
    const { data: alreadyPicked } = await supabase
        .from('snake_draft_picks')
        .select('id')
        .eq('draft_id', draftId)
        .eq('player_id', playerId)
        .maybeSingle()
    if (alreadyPicked) throw new Error('Player already picked in this draft')

    const now = new Date().toISOString()

    // Record pick
    await supabase
        .from('snake_draft_picks')
        .update({ player_id: playerId, picked_at: now })
        .eq('id', nextPick.id)

    // Add to roster
    await supabase.from('roster_players').insert({
        league_id: draft.league_id,
        league_season_id: draft.league_season_id,
        member_id: memberId,
        player_id: playerId,
        acquired_via: 'draft',
    })

    // Mark draft_pick asset as used (if it matches this round/owner)
    await supabase
        .from('draft_picks')
        .update({ is_used: true, used_at: now, rookie_draft_id: draftId })
        .eq('league_id', draft.league_id)
        .eq('current_owner_id', memberId)
        .eq('round', nextPick.round)
        .eq('is_used', false)
        .limit(1)

    // Check if all picks are done
    const { count } = await supabase
        .from('snake_draft_picks')
        .select('id', { count: 'exact', head: true })
        .eq('draft_id', draftId)
        .is('player_id', null)

    if (count === 0) {
        await supabase
            .from('drafts')
            .update({ status: 'completed', completed_at: now })
            .eq('id', draftId)
        await supabase.from('leagues').update({ status: 'active' }).eq('id', draft.league_id)
        console.log(`[rookieDraft] Draft ${draftId} completed`)
    }

    // Check if the picking member's roster is now over capacity
    const { data: leagueRow } = await supabase
        .from('leagues')
        .select('roster_size, taxi_slots')
        .eq('id', draft.league_id)
        .single()

    const rosterSize = (leagueRow as any)?.roster_size ?? 20
    const taxiSlots = (leagueRow as any)?.taxi_slots ?? 2

    const [{ count: activeCount }, { count: taxiCount }] = await Promise.all([
        supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', memberId)
            .eq('league_season_id', draft.league_season_id)
            .eq('is_on_ir', false)
            .eq('is_on_taxi', false),
        supabase
            .from('roster_players')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', memberId)
            .eq('league_season_id', draft.league_season_id)
            .eq('is_on_taxi', true),
    ])

    return {
        pick: nextPick,
        remaining: count ?? 0,
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
    const pickedIds = new Set((pickedRows ?? []).map((r: any) => r.player_id))

    // Best available = lowest nba_draft_number not yet picked
    const { data: players } = await supabase
        .from('players')
        .select('id')
        .not('nba_draft_number', 'is', null)
        .order('nba_draft_number', { ascending: true })
        .limit(100)

    const best = (players ?? []).find((p: any) => !pickedIds.has(p.id))
    if (!best) throw new Error('No available players for auto-pick')

    return makeSnakePick(draftId, memberId, best.id)
}

// ── Reseed picks for an in-progress draft (fixes traded-pick ownership) ───
export async function reseedRookieDraftPicks(draftId: string) {
    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .select('id, league_id, status')
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
    const draftOrder = orders.map((o: any) => o.member_id)

    // Build pickOwnerMap from current draft_picks trade assets
    const { data: draftPickAssets } = await supabase
        .from('draft_picks')
        .select('season_year, round, original_owner_id, current_owner_id')
        .eq('league_id', draft.league_id)
        .eq('is_used', false)
        .order('season_year', { ascending: true })

    const pickOwnerMap = new Map<string, string>()
    for (const dp of draftPickAssets ?? []) {
        const key = `${dp.original_owner_id}:${dp.round}`
        if (!pickOwnerMap.has(key)) pickOwnerMap.set(key, dp.current_owner_id)
    }

    // Delete existing picks and re-insert with correct ownership
    await supabase.from('snake_draft_picks').delete().eq('draft_id', draftId)

    const pickRows = []
    let overall = 1
    for (let round = 1; round <= CONFIG.ROOKIE_DRAFT_ROUNDS; round++) {
        const isEvenRound = round % 2 === 0
        const order = isEvenRound ? [...draftOrder].reverse() : draftOrder
        for (let i = 0; i < order.length; i++) {
            const originalOwner = order[i]
            const member_id = pickOwnerMap.get(`${originalOwner}:${round}`) ?? originalOwner
            pickRows.push({
                draft_id: draftId,
                overall_pick: overall++,
                round,
                pick_in_round: i + 1,
                member_id,
            })
        }
    }
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
                `overall_pick, round, pick_in_round, member_id, picked_at,
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

    const nextPick = (picks ?? []).find((p: any) => !p.player_id) ?? null

    return { draft, picks, orders, nextPick }
}
