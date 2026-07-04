import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

// The waiver and auction engines are SQL-only, so their load-bearing
// inequalities and ORDER BYs are guarded as exact source text: flipping a
// comparison operator or reordering a tiebreak key fails these expectations.
// tests/db-function-source-parity.test.ts keeps these files in sync with the
// deployed migrations.
const waivers = read('supabase/sql/functions/waivers-and-adds.sql')
const auction = read('supabase/sql/functions/auction-lifecycle.sql')
const dynastyTx = read('supabase/sql/functions/dynasty-transactions.sql')

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

    it('re-verifies the winning bidder budget at settlement', () => {
        expect(auction).toContain("IF v_budget.remaining < v_nom.current_bid_amount THEN\n      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';")
    })
})

describe('waiver claim resolution ordering (process_waiver_claim internals)', () => {
    it('picks the next claim by FAAB bid DESC, then priority, claim order, submit time, id', () => {
        expect(waivers).toContain(
            '   ORDER BY\n' +
            '     candidate.league_id,\n' +
            '     candidate.league_season_id,\n' +
            "     CASE WHEN claim_league.waiver_mode = 'faab' THEN candidate.bid_amount END DESC NULLS LAST,\n" +
            '     wp.priority ASC,\n' +
            '     candidate.claim_order ASC,\n' +
            '     candidate.submitted_at ASC,\n' +
            '     candidate.id ASC\n' +
            '   LIMIT 1;',
        )
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
