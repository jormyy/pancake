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

    // Create snake_draft_picks
    const pickRows = []
    let overall = 1
    for (let round = 1; round <= CONFIG.ROOKIE_DRAFT_ROUNDS; round++) {
        const isEvenRound = round % 2 === 0
        const order = isEvenRound ? [...draftOrder].reverse() : draftOrder
        for (let i = 0; i < order.length; i++) {
            pickRows.push({
                draft_id: draft.id,
                overall_pick: overall++,
                round,
                pick_in_round: i + 1,
                member_id: order[i],
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

    return { pick: nextPick, remaining: count ?? 0 }
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
