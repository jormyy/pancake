import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, latestPolicyDefinition, read } from './source-guard'

const migration = read('supabase/migrations/20260708000004_multi_team_trades.sql')
const api = read('supabase/functions/api/trades.ts')
const clientTrades = read('lib/trades.ts')
const composer = read('app/(modals)/propose-trade.tsx')
const multiTeamComposer = read('hooks/use-multi-team-trade-composer.ts')
const multiTeamBuilder = read('components/trades/MultiTeamTradeBuilder.tsx')
const multiTeamOverview = read('components/trades/MultiTeamTradeOverview.tsx')
const tradeAssetColumn = read('components/trades/TradeAssetColumn.tsx')
const tradeCard = read('components/trades/TradeCard.tsx')
const tradesScreen = read('app/(tabs)/trades.tsx')
const browserTradeGameplay = read('tests/e2e/browser-trade-gameplay.mjs')
const browserMultiTeamTradeGameplay = read('tests/e2e/browser-trade-multi-team.mjs')
const playerContext = read('lib/player-context.ts')
const tradePerspective = read('lib/trade-perspective.ts')

describe('multi-team trade schema and privacy', () => {
    it('adds explicit participants and routed trade item assets', () => {
        expect(migration).toContain('ADD COLUMN IF NOT EXISTS is_multi_team boolean NOT NULL DEFAULT false')
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.trade_participants')
        expect(migration).toContain('from_member_id uuid REFERENCES public.league_members(id)')
        expect(migration).toContain('to_member_id uuid REFERENCES public.league_members(id)')
        expect(migration).toContain('faab_amount int NOT NULL DEFAULT 0')
        expect(migration).toContain('trade_items_one_asset_check')
        expect(migration).toContain('((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) = 1')
    })

    it('extends pending trade privacy to every participant', () => {
        const tradePolicy = latestPolicyDefinition('trades_select_parties_or_accepted', 'trades')
        const itemPolicy = latestPolicyDefinition('trade_items_select_parties_or_accepted', 'trade_items')
        const participantPolicy = latestPolicyDefinition('trade_participants_select_parties_or_accepted', 'trade_participants')
        const visibilityHelper = latestFunctionDefinition('can_read_trade', 'private')

        expect(tradePolicy).toContain('private.can_read_trade(id)')
        expect(itemPolicy).toContain('private.can_read_trade(trade_id)')
        expect(participantPolicy).toContain('private.can_read_trade(trade_id)')
        expect(visibilityHelper).toContain('FROM public.trade_participants AS participant')
        expect(visibilityHelper).toContain('participant.member_id IN (SELECT private.my_member_ids())')
        expect(visibilityHelper).toContain('SECURITY DEFINER')
    })
})

describe('multi-team trade RPC lifecycle', () => {
    it('creates multi-team offers with participant acceptance and routed assets', () => {
        const createMulti = latestFunctionDefinition('create_multi_team_trade_offer', 'private')
        const replaceMulti = latestFunctionDefinition('replace_multi_team_trade_offer', 'private')
        const proposeMulti = latestFunctionDefinition('propose_multi_team_trade_atomic')
        const counterMulti = latestFunctionDefinition('counter_multi_team_trade_atomic')
        const editMulti = latestFunctionDefinition('edit_multi_team_trade_atomic')
        const acceptMulti = latestFunctionDefinition('accept_multi_team_trade_atomic')
        const acceptParticipant = latestFunctionDefinition('accept_trade_participant_atomic', 'private')
        const complete = latestFunctionDefinition('complete_accepted_trade_atomic')
        const veto = latestFunctionDefinition('veto_trade_atomic')
        const reject = latestFunctionDefinition('reject_trade_atomic')

        expect(createMulti).toContain('jsonb_array_elements(p_items) WITH ORDINALITY')
        expect(createMulti).toContain('Every item source and destination must be a trade participant.')
        expect(createMulti).toContain('Every participating team must send or receive at least one asset.')
        expect(createMulti).toContain('INSERT INTO trade_participants')
        expect(createMulti).toContain('INSERT INTO trade_items')
        expect(createMulti).toContain('from_member_id')
        expect(createMulti).toContain('to_member_id')
        expect(createMulti).toContain('faab_amount')
        expect(createMulti).toContain('v_proposer_required_drops')
        expect(createMulti).toContain('CASE WHEN member_id = p_proposer_member_id AND v_proposer_required_drops = 0 THEN now() ELSE NULL END')
        expect(replaceMulti).toContain('private.create_multi_team_trade_offer')
        expect(replaceMulti).toContain("v_replaced_status := 'countered'::trade_status")
        expect(replaceMulti).toContain("v_replaced_status := 'edited'::trade_status")
        expect(replaceMulti).toContain('countered_from_trade_id = v_countered_from_trade_id')
        expect(replaceMulti).toContain('edited_from_trade_id = v_edited_from_trade_id')
        expect(replaceMulti).toContain('version = v_trade.version + 1')
        expect(replaceMulti).toContain("DELETE FROM league_activity")
        expect(replaceMulti).toContain("'trade_countered'")
        expect(replaceMulti).toContain("'trade_edited'")
        expect(proposeMulti).toContain('private.create_multi_team_trade_offer')
        expect(counterMulti).toContain('private.replace_multi_team_trade_offer')
        expect(counterMulti).toContain("'counter'")
        expect(editMulti).toContain('private.replace_multi_team_trade_offer')
        expect(editMulti).toContain("'edit'")
        expect(acceptMulti).toContain('private.accept_trade_participant_atomic')
        expect(acceptParticipant).toContain('UPDATE trade_participants')
        expect(acceptParticipant).toContain('accepted_at IS NULL')
        expect(acceptParticipant).toContain('v_all_accepted')
        expect(acceptParticipant).toContain('PERFORM public.complete_accepted_trade_atomic(p_trade_id)')
        expect(complete).toContain('COALESCE(v_item.from_member_id')
        expect(complete).toContain('COALESCE(v_item.to_member_id')
        expect(complete).toContain('v_item.faab_amount')
        expect(veto).toContain('FROM trade_participants AS participant')
        expect(veto).toContain('participant.trade_id = p_trade_id')
        expect(reject).toContain('participant.accepted_at IS NULL')
    })

    it('uses routed multi-team ownership for reservation guards and roster mutations', () => {
        const guardSources = [
            latestFunctionDefinition('prevent_reserved_or_inactive_trade_accept', 'private'),
            latestFunctionDefinition('prevent_trade_drop_reserved_asset', 'private'),
            latestFunctionDefinition('validate_waiver_claim_drop_player', 'private'),
            latestFunctionDefinition('prevent_reserved_or_inactive_roster_move', 'private'),
            latestFunctionDefinition('prevent_reserved_drop_roster_delete', 'private'),
            latestFunctionDefinition('drop_player_atomic'),
            latestFunctionDefinition('toggle_ir_atomic'),
            latestFunctionDefinition('toggle_taxi_atomic'),
        ].join('\n')

        expect(guardSources).toContain('COALESCE(')
        expect(guardSources).toContain('from_member_id')
        expect(guardSources).toContain("CASE WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END")
        expect(guardSources).not.toContain("(item.side = 'proposer' AND trade.proposer_member_id")
        expect(guardSources).not.toContain("(item.side = 'recipient' AND trade.recipient_member_id")
    })

    it('cleans partial multi-team drop reservations when pending trades become terminal', () => {
        const cleanup = latestFunctionDefinition('cleanup_trade_drop_reservations_on_terminal_trade', 'private')

        expect(cleanup).toContain("NEW.status IN (\n    'rejected'::trade_status,")
        expect(cleanup).toContain("'withdrawn'::trade_status")
        expect(cleanup).toContain("'countered'::trade_status")
        expect(cleanup).toContain("'edited'::trade_status")
        expect(cleanup).toContain("'expired'::trade_status")
        expect(cleanup).toContain("'vetoed'::trade_status")
        expect(cleanup).toContain("'completed'::trade_status")
        expect(cleanup).toContain('OLD.status IS DISTINCT FROM NEW.status')
        expect(cleanup).not.toContain("OLD.status = 'accepted'::trade_status")
    })

    it('keeps Edge API calls behind service-role RPCs', () => {
        expect(api).toContain("path === '/trades/propose-multi'")
        expect(api).toContain("supabase.rpc('propose_multi_team_trade_atomic'")
        expect(api).toContain("supabase.rpc(action.rpc")
        expect(api).toContain('counter_multi_team_trade_atomic')
        expect(api).toContain('edit_multi_team_trade_atomic')
        expect(api).toContain("action.action === 'counter-multi'")
        expect(api).toContain("action.action === 'edit-multi'")
        expect(api).toContain("supabase.rpc('accept_multi_team_trade_atomic'")
        expect(api).toContain('fetchPendingTradeForAccept')
        expect(api).not.toContain("from('trade_items').insert")
    })
})

describe('multi-team trade UI and client mapping', () => {
    it('maps participants and routed FAAB/player/pick items on the client', () => {
        expect(clientTrades).toContain('TradeParticipant')
        expect(clientTrades).toContain("kind: 'faab'")
        expect(clientTrades).toContain('routedItems')
        expect(clientTrades).toContain('proposeMultiTeamTrade')
        expect(clientTrades).toContain('counterMultiTeamTrade')
        expect(clientTrades).toContain('editMultiTeamTrade')
        expect(clientTrades).toContain("'/trades/propose-multi'")
        expect(clientTrades).toContain('counter-multi')
        expect(clientTrades).toContain('edit-multi')
        expect(clientTrades).toContain("from('trade_participants')")
        expect(clientTrades).toContain('function getPendingIncomingTradeCount')
        expect(clientTrades).toContain('accepted_at')
    })

    it('exposes a multi-team composer and participant-aware trade card actions', () => {
        expect(composer).toContain('multiTeamMode')
        expect(composer).toContain('useMultiTeamTradeComposer')
        expect(multiTeamComposer).toContain('useReducer(multiTeamTradeReducer')
        expect(composer).toContain('counterMultiTeamTrade')
        expect(composer).toContain('editMultiTeamTrade')
        expect(composer).toContain('submitMultiTeamTradeComposer')
        expect(composer).toContain('MultiTeamTradeBuilder')
        expect(composer).toContain('proposeMultiTeamTrade')
        expect(multiTeamBuilder).toContain('MultiTeamTradeOverview')
        expect(multiTeamBuilder).toContain('accessibilityRole="tablist"')
        expect(multiTeamBuilder).toContain('accessibilityRole="tab"')
        expect(multiTeamOverview).toContain('DEAL OVERVIEW')
        expect(tradeCard).toContain('needsMemberAcceptance(trade, myMemberId)')
        expect(tradeCard).toContain('MultiTeamTradeOverview')
        expect(tradeCard).toContain('compact')
        expect(browserTradeGameplay).toContain('runBrowserMultiTeamTradeScenario')
        expect(browserTradeGameplay).toContain("process.argv.includes('--multi-team')")
        expect(browserMultiTeamTradeGameplay).toContain('mobile multi-team offer overview')
    })

    it('uses shared participant-aware perspective helpers in trade surfaces', () => {
        const pendingTradeCount = read('hooks/use-pending-trade-count.ts')
        const pendingTradeCountQuery = clientTrades.slice(
            clientTrades.indexOf('export async function getPendingIncomingTradeCount'),
            clientTrades.indexOf('export async function getVetoableTrades'),
        )

        expect(tradesScreen).toContain('isIncomingTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isOutgoingTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isVetoableTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isTradeHistoryForMember(trade, myMemberId)')
        expect(pendingTradeCount).toContain('getPendingIncomingTradeCount(memberId, leagueId)')
        expect(pendingTradeCount).not.toContain(".eq('recipient_member_id', memberId)")
        expect(clientTrades).toContain('and(is_multi_team.eq.false,recipient_member_id.eq.${memberId})')
        expect(clientTrades).toContain("query.not('id', 'in'")
        expect(pendingTradeCountQuery).not.toContain(".neq('proposer_member_id', memberId)")
        expect(tradePerspective).toContain('if (participant) return participant.acceptedAt == null')
        expect(tradePerspective).not.toContain("trade.proposerMemberId === memberId || !isTradeParticipant")
    })

    it('uses shared player context formatting in trade asset surfaces', () => {
        expect(playerContext).toContain('function playerSeasonContextText')
        expect(playerContext).toContain('function playerEligiblePositions')
        expect(tradeCard).toContain('playerSeasonContextText(item)')
        expect(tradesScreen).toContain('playerSeasonContextText(block.asset)')
        expect(tradesScreen).toContain('playerEligiblePositions(block.asset)')
        expect(tradeAssetColumn).toContain('playerSeasonContextText({')
    })
})
