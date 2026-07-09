import { describe, expect, it } from 'vitest'
import { read, readFunctionSources } from './source-guard'

// The waiver and auction engines are SQL-only, so their load-bearing
// inequalities and ORDER BYs are guarded as exact source text: flipping a
// comparison operator or reordering a tiebreak key fails these expectations.
// tests/db-function-source-parity.test.ts keeps these per-function sources in
// sync with the deployed migrations.
const waivers = readFunctionSources([
    ['clear_future_unlocked_lineups', 'private'],
    ['clear_trade_block_listing_for_asset', 'private'],
    ['validate_waiver_claim_drop_player', 'private'],
    ['release_roster_player_to_waivers', 'private'],
    'add_free_agent_atomic',
    'create_waiver_claim_atomic',
    'edit_waiver_claim_atomic',
    'cancel_waiver_claim_atomic',
    'reorder_waiver_claim_atomic',
    ['fail_waiver_claim', 'private'],
    'process_next_waiver_claim_atomic',
    'process_due_waiver_claims_atomic',
    'expire_waiver_wire_logs',
])
const auction = readFunctionSources([
    'start_auction_draft_atomic',
    'create_auction_nomination_atomic',
    'place_auction_bid_atomic',
    'close_auction_nomination_atomic',
    'withdraw_auction_nomination_atomic',
])
const dynastyTx = readFunctionSources([
    ['weekly_add_limit_message', 'private'],
    ['assert_weekly_add_available', 'private'],
])
const waiverApi = read('supabase/functions/api/waivers.ts')
const claimPlayerModal = read('app/(modals)/claim-player.tsx')

const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1

describe('auction bid guards (place_auction_bid_atomic / settlement)', () => {
    it('rejects non-positive bid amounts', () => {
        expect(auction).toContain("IF p_amount IS NULL OR p_amount < 1 THEN\n    RAISE EXCEPTION 'Bid amount must be a positive integer';")
    })

    it('requires a new bid to strictly exceed the current bid', () => {
        expect(auction).toContain("IF p_amount <= v_nom.current_bid_amount THEN\n    RAISE EXCEPTION 'Bid must exceed current bid of $%', v_nom.current_bid_amount;")
    })

    it('blocks the current highest bidder from re-bidding against themselves', () => {
        expect(auction).toContain("IF v_nom.current_bidder_id = p_member_id THEN\n    RAISE EXCEPTION 'You are already the highest bidder';")
    })

    it('rejects bids above the remaining draft budget', () => {
        expect(auction).toContain("IF v_budget.remaining < p_amount THEN\n    RAISE EXCEPTION 'Insufficient budget (you have $% remaining)', v_budget.remaining;")
    })

    it('requires auction bids to reserve $1 for remaining active roster slots', () => {
        expect(auction).toContain('v_required_reserve := GREATEST(v_roster_size - v_active_roster_count - 1, 0);')
        expect(auction).toContain('IF v_budget.remaining < p_amount + v_required_reserve THEN')
        expect(auction).toContain("Bid must leave at least $1 for each remaining active roster slot.")
    })

    it('auto-awards unbeatable real-auction bids server-side', () => {
        expect(auction).toContain('IF NOT v_draft.is_mock THEN')
        expect(auction).toContain('v_next_bid := p_amount + 1;')
        expect(auction).toContain('budget.member_id <> p_member_id')
        expect(auction).toContain('roster.active_count < v_roster_size')
        expect(auction).toContain('budget.remaining >= v_next_bid + GREATEST(v_roster_size - roster.active_count - 1, 0)')
        expect(auction).toContain("SET countdown_expires_at = now() - interval '1 millisecond'")
        expect(auction).toContain('PERFORM public.close_auction_nomination_atomic(p_nomination_id);')
    })

    it('re-verifies the winning bidder budget at settlement', () => {
        expect(auction).toContain("IF v_budget.remaining < v_nom.current_bid_amount THEN\n      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';")
    })
})

describe('waiver claim resolution ordering (process_waiver_claim internals)', () => {
    it('picks the next claim by FAAB bid DESC, then priority, claim order, submit time, id', () => {
        expect(waivers).toContain(
            '     ORDER BY\n' +
            '       candidate.league_id,\n' +
            '       candidate.league_season_id,\n' +
            "       CASE WHEN claim_league.waiver_mode = 'faab' THEN candidate.bid_amount END DESC NULLS LAST,\n" +
            '       wp.priority ASC,\n' +
            '       candidate.claim_order ASC,\n' +
            '       candidate.submitted_at ASC,\n' +
            '       candidate.id ASC',
        )
    })

    it('skips leagues whose advisory lock is held instead of blocking the batch', () => {
        expect(waivers).toContain('IF pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN')
    })

    it('re-applies the identical FAAB tie-break ordering under row locks', () => {
        expect(waivers).toContain(
            '   ORDER BY\n' +
            "     CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,\n" +
            '     wp.priority ASC,\n' +
            '     wc.claim_order ASC,\n' +
            '     wc.submitted_at ASC,\n' +
            '     wc.id ASC\n' +
            '   LIMIT 1\n' +
            '   FOR UPDATE OF wc;',
        )
    })

    it('sends the winning member to the back of the waiver priority queue', () => {
        expect(waivers).toContain('UPDATE waiver_priorities AS priority_row\n     SET priority = COALESCE(v_max_priority, 0) + 1')
    })

    it('fails remaining pending claims for the same player after a win', () => {
        expect(waivers).toContain("SET status = 'failed_priority',")
        expect(waivers).toContain("WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'")
        expect(waivers).toContain("ELSE 'Claimed by higher-priority team.'")
    })
})

describe('FAAB budget guards', () => {
    it('keeps $0 FAAB bids legal across UI, API, and SQL entry points', () => {
        expect(claimPlayerModal).toContain("const [bidInput, setBidInput] = useState('0')")
        expect(claimPlayerModal).toContain("const bidAmount = Math.max(0, parseInt(bidInput || '0', 10) || 0)")
        expect(waiverApi).toContain("optionalIntegerField(body, 'bidAmount', { min: 0 }) ?? 0")
        expect(count(waivers, 'v_bid_amount int := COALESCE(p_bid_amount, 0);')).toBe(2)
        expect(count(waivers, "IF v_bid_amount < 0 THEN\n    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'")).toBe(2)
    })

    it('rejects negative bids at submit and update time (both entry points)', () => {
        expect(count(waivers, "IF v_bid_amount < 0 THEN\n    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'")).toBe(2)
    })

    it('rejects bids above the available balance at submit and update time (both entry points)', () => {
        expect(count(waivers, "IF v_bid_amount > v_balance THEN\n      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'")).toBe(2)
    })

    it('re-checks the balance at processing time before awarding the claim', () => {
        expect(waivers).toContain("IF v_faab_balance < v_claim.bid_amount THEN\n      v_failure := 'Insufficient FAAB budget for this bid.';")
    })

    it('deducts exactly the winning bid from the FAAB balance', () => {
        expect(waivers).toContain('SET balance = balance_row.balance - v_claim.bid_amount,')
    })

    it('does not deduct failed lower-priority or lower-bid FAAB claims', () => {
        expect(count(waivers, 'SET balance = balance_row.balance - v_claim.bid_amount,')).toBe(1)
        expect(waivers).toContain("CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END")
        expect(waivers).toContain("jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)")
    })
})

describe('weekly add-limit guards', () => {
    it('blocks processing once the weekly add count reaches the league limit', () => {
        expect(waivers).toContain('IF COALESCE(v_weekly_add_count, 0) >= v_league.weekly_add_limit THEN')
    })

    it('blocks submissions once the weekly add count reaches the limit (shared assert)', () => {
        expect(dynastyTx).toContain('IF COALESCE(v_used, 0) >= v_limit THEN')
        expect(dynastyTx).toContain('RAISE EXCEPTION \'%\', private.weekly_add_limit_message(COALESCE(v_used, 0), v_limit)')
    })

    it('routes waiver submissions through the shared weekly add assert', () => {
        expect(count(waivers, 'PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);')).toBeGreaterThanOrEqual(2)
    })
})
