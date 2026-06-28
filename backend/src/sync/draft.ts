import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'

export const NOMINATION_ORDER_MODES = ['user_nominated', 'by_projection', 'alphabetical'] as const
export type NominationOrderMode = (typeof NOMINATION_ORDER_MODES)[number]

export async function startDraft(
    leagueId: string,
    nominationOrderMode: NominationOrderMode = 'user_nominated',
) {
    if (!NOMINATION_ORDER_MODES.includes(nominationOrderMode)) {
        throw new Error(`Invalid nomination order mode: ${nominationOrderMode}`)
    }
    const { data: draft, error } = await supabase.rpc('start_auction_draft_atomic', {
        p_league_id: leagueId,
        p_nomination_order_mode: nominationOrderMode,
    })
    if (error) throw error

    console.log(
        `[draft] Started draft ${draft.id} for league ${leagueId}`,
    )
    return draft
}

export async function nominatePlayer(draftId: string, memberId: string, playerId: string, userId: string) {
    const { data: nomination, error: nomErr } = await supabase.rpc('create_auction_nomination_atomic', {
        p_draft_id: draftId,
        p_member_id: memberId,
        p_player_id: playerId,
        p_user_id: userId,
        p_countdown_seconds: CONFIG.NOMINATION_COUNTDOWN_SECONDS,
    })
    if (nomErr) {
        if ((nomErr as { code?: string }).code === '23505') {
            const details =
                typeof (nomErr as { message?: string }).message === 'string'
                    ? (nomErr as { message: string }).message
                    : ''
            if (details.includes('nominations_one_open_per_draft')) {
                throw new Error('A nomination is already open - wait for it to close')
            }
            throw new Error('Player already nominated in this draft')
        }
        throw nomErr
    }

    return nomination
}

export async function placeBid(
    draftId: string,
    memberId: string,
    nominationId: string,
    amount: number,
    userId: string,
) {
    if (!Number.isInteger(amount) || amount < CONFIG.MIN_BID) {
        throw new Error('Bid amount must be a positive integer')
    }

    const { error } = await supabase.rpc('place_auction_bid_atomic', {
        p_draft_id: draftId,
        p_member_id: memberId,
        p_nomination_id: nominationId,
        p_amount: amount,
        p_user_id: userId,
    })
    if (error) throw error

    return { ok: true }
}

export async function withdrawNomination(
    draftId: string,
    memberId: string,
    nominationId: string,
    userId: string,
) {
    const { data: visibleNomination, error: visibleError } = await supabase
        .from('nominations')
        .select('id')
        .eq('id', nominationId)
        .eq('draft_id', draftId)
        .eq('nominating_member_id', memberId)
        .eq('status', 'open')
        .maybeSingle()
    if (visibleError) throw visibleError
    if (!visibleNomination) return { ok: true, withdrawn: false }

    const { data, error } = await supabase.rpc('withdraw_auction_nomination_atomic', {
        p_nomination_id: nominationId,
        p_member_id: memberId,
        p_user_id: userId,
    })
    if (error) throw error
    return { ok: true, withdrawn: Boolean(data) }
}

export async function closeExpiredNominations() {
    const now = new Date().toISOString()
    const { data: expired, error: expiredErr } = await supabase
        .from('nominations')
        .select('id, draft_id, player_id, current_bid_amount, current_bidder_id')
        .eq('status', 'open')
        .lt('countdown_expires_at', now)
    if (expiredErr) throw expiredErr

    if (!expired || expired.length === 0) return { checked: 0, closed: 0, failed: 0 }

    let closed = 0
    let failed = 0

    const results = await Promise.allSettled(
        expired.map(async (nom) => {
            const { data, error } = await supabase.rpc('close_auction_nomination_atomic', {
                p_nomination_id: nom.id,
            })
            if (error) throw error
            return Boolean(data)
        }),
    )

    for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status === 'fulfilled') {
            if (r.value) closed += 1
        } else {
            failed += 1
            console.error(`[draft] Error closing nomination ${expired[i].id}:`, r.reason)
        }
    }

    return { checked: expired.length, closed, failed }
}

// Draft state is read client-side via RLS-scoped Supabase queries (lib/draft.ts).
// A backend service-role read would bypass RLS and leak private draft state, so
// the former getDraftState() backend reader + its GET route were removed.
