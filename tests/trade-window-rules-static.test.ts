import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read } from './source-guard'

describe('trade window feedback rules', () => {
    it('opens trades outside the deadline-to-champion lock', () => {
        const createTradeOffer = latestFunctionDefinition('create_trade_offer', 'private')
        const acceptTrade = latestFunctionDefinition('accept_trade_participant_atomic', 'private')
        const processDueTrades = latestFunctionDefinition('process_due_accepted_trades_atomic')
        const acceptDeadlineGuard = latestFunctionDefinition('prevent_trade_acceptance_after_deadline')
        const proposeTrade = read('app/(modals)/propose-trade.tsx')

        for (const status of ['setup', 'drafting', 'active', 'playoffs', 'offseason']) {
            expect(createTradeOffer).toContain(`'${status}'::league_status`)
        }
        expect(createTradeOffer).toContain("v_league.status = 'archived'::league_status")
        expect(createTradeOffer).toContain('v_champion_finalized')
        expect(createTradeOffer).toContain("v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized")
        expect(createTradeOffer).toContain('Trades are locked from the trade deadline until the champion is finalized.')
        expect(createTradeOffer).not.toContain('Trades require an active or playoff season.')

        expect(acceptDeadlineGuard).toContain("matchup.matchup_type = 'playoff_final'::matchup_type")
        expect(acceptDeadlineGuard).toContain('matchup.is_finalized = true')
        expect(acceptDeadlineGuard).toContain('matchup.winner_member_id IS NOT NULL')
        expect(acceptDeadlineGuard).toContain("v_league_status = 'playoffs'::league_status AND NOT v_champion_finalized")

        expect(acceptTrade).toContain("v_league.status = 'archived'::league_status")
        expect(acceptTrade).not.toContain('Trades require an active or playoff season.')
        expect(processDueTrades).toContain("league.status <> 'archived'::public.league_status")
        expect(proposeTrade).toContain('Trades are locked only from the trade deadline until the champion is finalized.')
    })
})
