import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'

// ── Start Draft ────────────────────────────────────────────────
export async function startDraft(leagueId: string) {
    const { data: league, error: leagueErr } = await supabase
        .from('leagues')
        .select('id, auction_budget, roster_size, ir_slots')
        .eq('id', leagueId)
        .single()
    if (leagueErr) throw leagueErr

    const { data: season, error: seasonErr } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (seasonErr) throw new Error('No active season for this league')

    const { data: existing } = await supabase
        .from('drafts')
        .select('id, status')
        .eq('league_id', leagueId)
        .eq('league_season_id', season.id)
        .in('status', ['pending', 'in_progress'])
        .maybeSingle()
    if (existing) throw new Error('A draft already exists for this league season')

    const { data: members, error: membersErr } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', leagueId)
    if (membersErr) throw membersErr
    if (!members || members.length < 2) throw new Error('Need at least 2 managers to start a draft')

    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .insert({
            league_id: leagueId,
            league_season_id: season.id,
            draft_type: 'auction',
            status: 'in_progress',
            budget_per_team: league.auction_budget,
            started_at: new Date().toISOString(),
            current_nomination_order: 1,
        })
        .select()
        .single()
    if (draftErr) throw draftErr

    // Randomly shuffle nomination order
    const shuffled = [...members].sort(() => Math.random() - 0.5)

    const orderRows = shuffled.map((m, i) => ({
        draft_id: draft.id,
        member_id: m.id,
        position: i + 1,
    }))
    const { error: orderErr } = await supabase.from('draft_orders').insert(orderRows)
    if (orderErr) throw orderErr

    const budgetRows = shuffled.map((m) => ({
        draft_id: draft.id,
        member_id: m.id,
        initial_budget: league.auction_budget,
        remaining: league.auction_budget,
    }))
    const { error: budgetErr } = await supabase.from('draft_budgets').insert(budgetRows)
    if (budgetErr) throw budgetErr

    await supabase.from('leagues').update({ status: 'drafting' }).eq('id', leagueId)

    console.log(
        `[draft] Started draft ${draft.id} for league ${leagueId} with ${members.length} managers`,
    )
    return draft
}

// ── Nominate Player ────────────────────────────────────────────
export async function nominatePlayer(draftId: string, memberId: string, playerId: string) {
    const { data: draft, error: draftErr } = await supabase
        .from('drafts')
        .select('id, league_id, league_season_id, current_nomination_order, status')
        .eq('id', draftId)
        .single()
    if (draftErr || !draft) throw new Error('Draft not found')
    if (draft.status !== 'in_progress') throw new Error('Draft is not in progress')

    const { data: orders } = await supabase
        .from('draft_orders')
        .select('member_id, position')
        .eq('draft_id', draftId)
        .order('position')
    if (!orders || orders.length === 0) throw new Error('No draft order found')

    const turnIndex = (draft.current_nomination_order - 1) % orders.length
    if (orders[turnIndex].member_id !== memberId) throw new Error("It's not your turn to nominate")

    const { data: openNom } = await supabase
        .from('nominations')
        .select('id')
        .eq('draft_id', draftId)
        .eq('status', 'open')
        .maybeSingle()
    if (openNom) throw new Error('A nomination is already open — wait for it to close')

    const { data: alreadyNominated } = await supabase
        .from('nominations')
        .select('id')
        .eq('draft_id', draftId)
        .eq('player_id', playerId)
        .maybeSingle()
    if (alreadyNominated) throw new Error('Player already nominated in this draft')

    const { count } = await supabase
        .from('nominations')
        .select('id', { count: 'exact', head: true })
        .eq('draft_id', draftId)
    const nominationOrder = (count ?? 0) + 1

    const expiresAt = new Date(Date.now() + CONFIG.NOMINATION_COUNTDOWN_SECONDS * 1000).toISOString()

    const { data: nomination, error: nomErr } = await supabase
        .from('nominations')
        .insert({
            draft_id: draftId,
            nominating_member_id: memberId,
            player_id: playerId,
            nomination_order: nominationOrder,
            status: 'open',
            current_bid_amount: 0,
            current_bidder_id: null,
            countdown_expires_at: expiresAt,
        })
        .select()
        .single()
    if (nomErr) throw nomErr

    return nomination
}

// ── Place Bid ──────────────────────────────────────────────────
export async function placeBid(
    draftId: string,
    memberId: string,
    nominationId: string,
    amount: number,
) {
    if (!Number.isInteger(amount) || amount < CONFIG.MIN_BID) {
        throw new Error('Bid amount must be a positive integer')
    }

    const { error } = await supabase.rpc('place_auction_bid_atomic', {
        p_draft_id: draftId,
        p_member_id: memberId,
        p_nomination_id: nominationId,
        p_amount: amount,
    })
    if (error) throw error

    return { ok: true }
}

// ── Close Expired Nominations (cron) ──────────────────────────
export async function closeExpiredNominations() {
    const now = new Date().toISOString()
    const { data: expired } = await supabase
        .from('nominations')
        .select('id, draft_id, player_id, current_bid_amount, current_bidder_id')
        .eq('status', 'open')
        .lt('countdown_expires_at', now)

    if (!expired || expired.length === 0) return

    for (const nom of expired) {
        try {
            const { error } = await supabase.rpc('close_auction_nomination_atomic', {
                p_nomination_id: nom.id,
            })
            if (error) throw error
        } catch (e) {
            console.error(`[draft] Error closing nomination ${nom.id}:`, e)
        }
    }
}

// ── Get Draft State ────────────────────────────────────────────
export async function getDraftState(draftId: string) {
    const [{ data: draft }, { data: orders }, { data: budgets }, { data: nominations }] =
        await Promise.all([
            supabase
                .from('drafts')
                .select(
                    'id, league_id, status, current_nomination_order, budget_per_team, started_at',
                )
                .eq('id', draftId)
                .single(),
            supabase
                .from('draft_orders')
                .select('position, member_id, league_members(team_name)')
                .eq('draft_id', draftId)
                .order('position'),
            supabase
                .from('draft_budgets')
                .select('member_id, remaining, initial_budget, league_members(team_name)')
                .eq('draft_id', draftId),
            supabase
                .from('nominations')
                .select(
                    `
        id, status, current_bid_amount, current_bidder_id, countdown_expires_at,
        winning_member_id, final_price, nominating_member_id, nominated_at, nomination_order,
        players ( display_name, nba_team, position )
      `,
                )
                .eq('draft_id', draftId)
                .order('nomination_order'),
        ])

    return { draft, orders, budgets, nominations }
}
