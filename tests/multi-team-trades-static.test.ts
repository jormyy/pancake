import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, latestPolicyDefinition, read } from './source-guard'

const migration = read('supabase/migrations/20260708000004_multi_team_trades.sql')
const api = read('supabase/functions/api/trades.ts')
const clientTrades = read('lib/trades.ts')
const composer = read('app/(modals)/propose-trade.tsx')
const multiTeamComposer = read('hooks/use-multi-team-trade-composer.ts')
const tradeCard = read('components/trades/TradeCard.tsx')
const tradesScreen = read('app/(tabs)/trades.tsx')
const playerContext = read('lib/player-context.ts')

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

        expect(tradePolicy).toContain('FROM public.trade_participants AS participant')
        expect(tradePolicy).toContain('participant.member_id IN (SELECT private.my_member_ids())')
        expect(itemPolicy).toContain('FROM public.trade_participants AS participant')
        expect(participantPolicy).toContain('trade_participants.member_id IN (SELECT private.my_member_ids())')
    })
})

describe('multi-team trade RPC lifecycle', () => {
    it('creates multi-team offers with participant acceptance and routed assets', () => {
        const createMulti = latestFunctionDefinition('create_multi_team_trade_offer', 'private')
        const proposeMulti = latestFunctionDefinition('propose_multi_team_trade_atomic')
        const acceptMulti = latestFunctionDefinition('accept_multi_team_trade_atomic')
        const complete = latestFunctionDefinition('complete_accepted_trade_atomic')
        const veto = latestFunctionDefinition('veto_trade_atomic')

        expect(createMulti).toContain('jsonb_array_elements(p_items) WITH ORDINALITY')
        expect(createMulti).toContain('Every item source and destination must be a trade participant.')
        expect(createMulti).toContain('Every participating team must send or receive at least one asset.')
        expect(createMulti).toContain('INSERT INTO trade_participants')
        expect(createMulti).toContain('INSERT INTO trade_items')
        expect(createMulti).toContain('from_member_id')
        expect(createMulti).toContain('to_member_id')
        expect(createMulti).toContain('faab_amount')
        expect(proposeMulti).toContain('private.create_multi_team_trade_offer')
        expect(acceptMulti).toContain('UPDATE trade_participants')
        expect(acceptMulti).toContain('accepted_at IS NULL')
        expect(acceptMulti).toContain('v_all_accepted')
        expect(acceptMulti).toContain('PERFORM public.complete_accepted_trade_atomic(p_trade_id)')
        expect(complete).toContain('COALESCE(v_item.from_member_id')
        expect(complete).toContain('COALESCE(v_item.to_member_id')
        expect(complete).toContain('v_item.faab_amount')
        expect(veto).toContain('FROM trade_participants AS participant')
        expect(veto).toContain('participant.trade_id = p_trade_id')
    })

    it('keeps Edge API calls behind service-role RPCs', () => {
        expect(api).toContain("path === '/trades/propose-multi'")
        expect(api).toContain("supabase.rpc('propose_multi_team_trade_atomic'")
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
        expect(clientTrades).toContain("'/trades/propose-multi'")
        expect(clientTrades).toContain("from('trade_participants')")
        expect(clientTrades).toContain('function isIncomingTradeForMember')
        expect(clientTrades).toContain('function isTradeHistoryForMember')
        expect(clientTrades).toContain('function getPendingIncomingTradeCount')
    })

    it('exposes a multi-team composer and participant-aware trade card actions', () => {
        expect(composer).toContain('multiTeamMode')
        expect(composer).toContain('useMultiTeamTradeComposer')
        expect(multiTeamComposer).toContain('selectedParticipantIds')
        expect(multiTeamComposer).toContain('buildMultiTeamItems')
        expect(multiTeamComposer).toContain('loadParticipantAssets')
        expect(composer).toContain('proposeMultiTeamTrade')
        expect(composer).toContain('MULTI-TEAM BUILDER')
        expect(tradeCard).toContain('isMultiParticipant')
        expect(tradeCard).toContain('participantAcceptanceText')
        expect(tradeCard).toContain("item.kind === 'faab'")
        expect(tradeCard).toContain('acceptTrade(trade.id, myMemberId')
    })

    it('uses shared participant-aware perspective helpers in trade surfaces', () => {
        const pendingTradeCount = read('hooks/use-pending-trade-count.ts')

        expect(tradesScreen).toContain('isIncomingTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isOutgoingTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isVetoableTradeForMember(trade, myMemberId)')
        expect(tradesScreen).toContain('isTradeHistoryForMember(trade, myMemberId)')
        expect(pendingTradeCount).toContain('getPendingIncomingTradeCount(memberId, leagueId)')
        expect(pendingTradeCount).not.toContain(".eq('recipient_member_id', memberId)")
    })

    it('uses shared player context formatting in trade asset surfaces', () => {
        expect(playerContext).toContain('function playerSeasonContextText')
        expect(playerContext).toContain('function playerEligiblePositions')
        expect(tradeCard).toContain('playerSeasonContextText(item)')
        expect(tradesScreen).toContain('playerSeasonContextText(block.asset)')
        expect(tradesScreen).toContain('playerEligiblePositions(block.asset)')
        expect(composer).toContain('playerSeasonContextText({')
    })
})
