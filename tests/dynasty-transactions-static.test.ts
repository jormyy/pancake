import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, readFunctionSources } from './source-guard'

const read = (path: string) => readFileSync(path, 'utf8')

function sqlBetween(sql: string, start: string, end: string): string {
    const startIndex = sql.indexOf(start)
    const endIndex = sql.indexOf(end, startIndex + start.length)
    if (startIndex < 0 || endIndex < 0) throw new Error(`Could not find SQL block ${start}`)
    return sql.slice(startIndex, endIndex)
}

describe('dynasty transaction release contracts', () => {
    it('adds server-owned weekly add, FAAB, activity, preference, and trade-block schema', () => {
        const schema = read('supabase/migrations/20260701000003_dynasty_transactions_schema.sql')

        expect(schema).toContain('weekly_add_limit')
        expect(schema).toContain('waiver_mode')
        expect(schema).toContain('faab_balances')
        expect(schema).toContain('weekly_add_counts')
        expect(schema).toContain('league_activity')
        expect(schema).toContain('notification_preferences')
        expect(schema).toContain('trade_block_items')
        expect(schema).toContain('get_member_transaction_state')
        expect(schema).toContain('commissioner_adjust_faab_balance_atomic')
        expect(schema).toContain('commissioner_override_weekly_add_count_atomic')
    })

    it('keeps waiver limits and FAAB processing atomic', () => {
        const waivers = read('supabase/migrations/20260701000004_dynasty_waivers_and_add_limits.sql')
        const api = read('supabase/functions/api/waivers.ts')

        expect(waivers).toContain('private.assert_weekly_add_available')
        expect(waivers).toContain('private.consume_weekly_add')
        const addFreeAgentAtomic = sqlBetween(
            waivers,
            'CREATE OR REPLACE FUNCTION public.add_free_agent_atomic',
            'DROP FUNCTION IF EXISTS public.create_waiver_claim_atomic',
        )
        const releaseRosterPlayerToWaivers = sqlBetween(
            waivers,
            'CREATE OR REPLACE FUNCTION private.release_roster_player_to_waivers',
            'CREATE OR REPLACE FUNCTION public.add_free_agent_atomic',
        )
        const createWaiverClaimAtomic = sqlBetween(
            waivers,
            'CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic',
            'CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic',
        )
        const editWaiverClaimAtomic = sqlBetween(
            waivers,
            'CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic',
            'CREATE OR REPLACE FUNCTION public.reorder_waiver_claim_atomic',
        )
        const processNextWaiverClaimAtomic = sqlBetween(
            waivers,
            'CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic',
            'REVOKE ALL ON FUNCTION public.add_free_agent_atomic',
        )
        expect(addFreeAgentAtomic).toContain('private.clear_future_unlocked_lineups')
        expect(addFreeAgentAtomic).not.toContain('DELETE FROM weekly_lineups')
        expect(waivers).toContain('private.validate_waiver_claim_drop_player')
        expect(createWaiverClaimAtomic).toContain('private.validate_waiver_claim_drop_player')
        expect(editWaiverClaimAtomic).toContain('private.validate_waiver_claim_drop_player')
        expect(processNextWaiverClaimAtomic).toContain('private.validate_waiver_claim_drop_player')
        expect(waivers).toContain('private.clear_trade_block_listing_for_asset')
        expect(releaseRosterPlayerToWaivers).toContain('private.clear_trade_block_listing_for_asset')
        expect(waivers).toContain('bid_amount')
        expect(waivers).toContain('private.fail_waiver_claim')
        expect(waivers).toContain('edit_waiver_claim_atomic')
        expect(waivers).toContain('reorder_waiver_claim_atomic')
        expect(waivers).toContain('AND wc.player_id = v_target_player_id')
        expect(waivers).toMatch(/CASE WHEN claim_league\.waiver_mode = 'faab' THEN candidate\.bid_amount END DESC/)
        expect(waivers).toContain('wp.priority ASC')
        expect(waivers).toContain('candidate.claim_order ASC')
        expect(waivers).toContain('UPDATE faab_balances AS balance_row')
        expect(waivers).toContain('balance_row.balance - v_claim.bid_amount')
        expect(api).toContain("p_bid_amount")
        expect(api).toContain('/edit$')
        expect(api).toContain('/reorder$')
    })

    it('keeps trade negotiation and trade block actions behind RPCs', () => {
        const trades = readFunctionSources([
            ['clear_trade_block_listing_on_inactive_roster', 'private'],
            ['create_trade_offer', 'private'],
            'propose_trade_atomic',
            ['create_multi_team_trade_offer', 'private'],
            'propose_multi_team_trade_atomic',
            ['replace_trade_offer', 'private'],
            'counter_trade_atomic',
            'edit_trade_atomic',
            ['prevent_expired_or_unfunded_trade_accept', 'private'],
            'expire_pending_trades_atomic',
            'complete_accepted_trade_atomic',
            'accept_multi_team_trade_atomic',
            'reject_trade_atomic',
            'withdraw_trade_atomic',
            'process_due_accepted_trades_atomic',
            'add_trade_block_item_atomic',
            'remove_trade_block_item_atomic',
        ])
        const tradeNegotiationMigration = read('supabase/migrations/20260701000005_dynasty_trade_negotiation.sql')
        const api = read('supabase/functions/api/trades.ts')

        expect(trades).toContain('counter_trade_atomic')
        expect(trades).toContain('edit_trade_atomic')
        expect(trades).toContain('expire_pending_trades_atomic')
        expect(trades).toContain('add_trade_block_item_atomic')
        expect(trades).toContain('remove_trade_block_item_atomic')
        expect(trades).toContain('prevent_expired_or_unfunded_trade_accept')
        expect(trades).toContain("v_replaced_status := 'countered'::trade_status")
        expect(trades).toContain("v_replaced_status := 'edited'::trade_status")
        expect(trades).toContain('replaced_by_trade_id')
        expect(trades).toContain('proposer_faab_amount')
        expect(trades).toContain('recipient_faab_amount')
        expect(trades).toContain('clear_trade_block_listing_on_inactive_roster')
        const createTradeOffer = latestFunctionDefinition('create_trade_offer', 'private')
        expect(createTradeOffer).toContain("'setup'::league_status")
        expect(createTradeOffer).toContain("'drafting'::league_status")
        expect(createTradeOffer).toContain("'offseason'::league_status")
        expect(createTradeOffer).toContain("v_league.status = 'archived'::league_status")
        expect(createTradeOffer).toContain('v_champion_finalized')
        expect(createTradeOffer).toContain("Trades are locked from the trade deadline until the champion is finalized.")
        expect(createTradeOffer).toContain("RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'")
        const replaceTradeOffer = latestFunctionDefinition('replace_trade_offer', 'private')
        const completeAcceptedTradeAtomic = latestFunctionDefinition('complete_accepted_trade_atomic')
        const addTradeBlockItemAtomic = latestFunctionDefinition('add_trade_block_item_atomic')
        const counterTradeAtomic = latestFunctionDefinition('counter_trade_atomic')
        const editTradeAtomic = latestFunctionDefinition('edit_trade_atomic')
        expect(createTradeOffer).not.toContain("v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status)")
        expect(createTradeOffer).toMatch(/player_id = ANY\(v_offer_player_ids\)[\s\S]*AND is_on_ir = false[\s\S]*AND is_on_taxi = false/)
        expect(createTradeOffer).toMatch(/player_id = ANY\(v_request_player_ids\)[\s\S]*AND is_on_ir = false[\s\S]*AND is_on_taxi = false/)
        expect(replaceTradeOffer).toContain('v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now()')
        expect(replaceTradeOffer).toMatch(/UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;\s+RETURN NULL;/)
        expect(replaceTradeOffer).not.toMatch(/UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;\s+RAISE EXCEPTION/)
        expect(counterTradeAtomic).toContain('private.replace_trade_offer')
        expect(counterTradeAtomic).toContain("'counter'")
        expect(editTradeAtomic).toContain('private.replace_trade_offer')
        expect(editTradeAtomic).toContain("'edit'")
        expect(completeAcceptedTradeAtomic).toContain('private.clear_trade_block_listing_for_asset')
        expect(completeAcceptedTradeAtomic).toContain('v_item.player_id')
        expect(completeAcceptedTradeAtomic).toContain('v_item.pick_id')
        expect(completeAcceptedTradeAtomic).toContain("v_league.status = 'archived'::league_status")
        expect(tradeNegotiationMigration).toContain('AFTER UPDATE OF is_on_ir, is_on_taxi ON public.roster_players')
        expect(addTradeBlockItemAtomic).toContain('AND is_on_ir = false')
        expect(addTradeBlockItemAtomic).toContain('AND is_on_taxi = false')
        expect(addTradeBlockItemAtomic).toContain('Only active roster players can be listed on the trade block.')
        expect(api).toContain('REPLACE_TRADE_ACTIONS')
        expect(api).toContain('sourceTradeMetadataKey')
        expect(api).toContain('replaceTrade(userId, tradeId, body')
        expect(api).toContain("throw new ValidationError('This trade offer has expired.')")
        expect(api).toContain("path === '/trades/block'")
        expect(api).not.toContain("from('trades').update")
    })

    it('keeps trade composer prefill markers out of render state', () => {
        const modal = read('app/(modals)/propose-trade.tsx')

        expect(modal).toContain('const prefillAppliedToRef = useRef<string | null>(null)')
        expect(modal).not.toContain('setPrefillAppliedTo')
        expect(modal).not.toContain('[prefillAppliedTo,')
    })

    it('keeps trade and waiver UI entry points aligned with server guards', () => {
        const league = read('lib/league.ts')
        const proposeModal = read('app/(modals)/propose-trade.tsx')
        const multiTeamComposer = read('hooks/use-multi-team-trade-composer.ts')
        const tradesScreen = read('app/(tabs)/trades.tsx')
        const playersScreen = read('app/(tabs)/players.tsx')

        expect(league).toContain("const TRADE_OPEN_STATUSES = new Set<LeagueStatus>(['setup', 'drafting', 'active', 'playoffs', 'offseason'])")
        expect(league).toContain('if (!TRADE_OPEN_STATUSES.has(league.status)) return true')
        expect(league).toContain("if (league.status !== 'active' && league.status !== 'playoffs') return false")
        expect(multiTeamComposer).toContain('export const isTradeableRosterPlayer')
        expect(proposeModal).toContain('isTradeableRosterPlayer')
        expect(proposeModal).toContain('theirData.filter(isTradeableRosterPlayer)')
        expect(proposeModal).toContain('myData.filter(isTradeableRosterPlayer)')
        expect(tradesScreen).toContain('roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)')
        expect(playersScreen).toContain('push(`/(modals)/claim-player?playerId=${player.id}`)')
        expect(playersScreen).not.toContain('onAdd={quickAdd.handleAdd}')
    })
})
