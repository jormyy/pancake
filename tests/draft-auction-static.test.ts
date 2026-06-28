import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read, sources } from './source-guard'

const {
    scoringCronAuctionMigration,
    etSeasonYearMigration,
    auctionLifecycleMigration,
    auctionAuthLockMigration,
    auctionWithdrawAuthMigration,
    inviteTradeLineupMigration,
    rosterOwnershipHistoryMigration,
    rookieDraftLedgerMigration,
    lineupCurrentSeasonMigration,
    playoffWaiverSeasonMigration,
    playoffBracketFreezeMigration,
    playoffScheduleTradeDeadlineMigration,
    integrationLintMigration,
    inviteCodeSecurityMigration,
    rpcArrayCapsMigration,
    internalEdgeTokenMigration,
    waiverMigration,
} = sources

describe('logic hardening source guards - draft, auction, roster history', () => {
    it('guards auction startup by league lifecycle and existing non-cancelled drafts', () => {
        const startBody = latestFunctionDefinition('start_auction_draft_atomic')

        expect(startBody).toContain("v_league.status IS DISTINCT FROM 'setup'::league_status")
        expect(startBody).toContain("status <> 'cancelled'::draft_status")
    })

    it('restores the auction close draft-status gate before roster mutation', () => {
        const closeBody = latestFunctionDefinition('close_auction_nomination_atomic')
        const statusGateIndex = closeBody.indexOf("v_draft.status <> 'in_progress'::draft_status")
        const rosterMutationIndex = closeBody.indexOf('INSERT INTO roster_players')

        expect(statusGateIndex).toBeGreaterThan(-1)
        expect(rosterMutationIndex).toBeGreaterThan(statusGateIndex)
        expect(closeBody).toContain('RETURN false;')
    })

    it('keeps auction nomination creation and bidding behind DB lifecycle and roster gates', () => {
        const nominateBody = latestFunctionDefinition('create_auction_nomination_atomic')
        const bidBody = latestFunctionDefinition('place_auction_bid_atomic')

        expect(nominateBody).toContain('FOR UPDATE')
        expect(nominateBody).toContain('v_draft.current_nomination_order')
        expect(nominateBody).toContain('It is not your turn to nominate')
        expect(nominateBody).toContain('Player is already rostered')
        expect(bidBody).toContain("v_draft.status <> 'in_progress'::draft_status")
        expect(bidBody).toContain('v_active_roster_count >= v_roster_size')
    })

    it('requires user ownership and roster advisory locks for auction manager RPCs', () => {
        const nominateBody = latestFunctionDefinition('create_auction_nomination_atomic')
        const bidBody = latestFunctionDefinition('place_auction_bid_atomic')
        const closeBody = latestFunctionDefinition('close_auction_nomination_atomic')

        expect(read('backend-legacy-railway/src/routes/draft.ts')).toContain('verifyOwnMember(req.userId, memberId)')
        expect(read('backend-legacy-railway/src/sync/draft.ts')).toContain('p_user_id: userId')

        for (const body of [nominateBody, bidBody]) {
            expect(body).toContain('p_user_id uuid')
            expect(body).toContain('Not authorized to act for this member')
            expect(body).toContain('user_id = p_user_id')
        }

        expect(nominateBody).toContain('hashtext(p_member_id::text)')
        expect(nominateBody).toContain('hashtext(p_player_id::text)')
        expect(bidBody.indexOf('hashtext(p_member_id::text)')).toBeLessThan(bidBody.indexOf('FROM leagues'))
        expect(bidBody.indexOf('hashtext(v_nom.player_id::text)')).toBeLessThan(bidBody.indexOf('FROM leagues'))
        expect(closeBody.indexOf('hashtext(v_nom.current_bidder_id::text)')).toBeLessThan(closeBody.indexOf('FROM leagues'))
        expect(closeBody.indexOf('hashtext(v_nom.player_id::text)')).toBeLessThan(closeBody.indexOf('FROM leagues'))
    })

    it('requires user ownership for auction withdrawal at the RPC layer', () => {
        const withdrawBody = latestFunctionDefinition('withdraw_auction_nomination_atomic')

        expect(withdrawBody).toContain('p_user_id uuid')
        expect(withdrawBody).not.toContain('p_user_id uuid DEFAULT NULL')
        expect(withdrawBody).toContain('p_user_id IS NULL OR NOT EXISTS')
        expect(withdrawBody).toContain('user_id = p_user_id')
        expect(read('backend-legacy-railway/src/sync/draft.ts')).toContain('p_user_id: userId')
    })

    it('serializes invite-code joins with league lifecycle transitions', () => {
        const joinBody = latestFunctionDefinition('join_league_by_invite_code')
        const lockIndex = joinBody.indexOf('FOR UPDATE')
        const statusGateIndex = joinBody.indexOf("v_league.status IS DISTINCT FROM 'setup'::public.league_status")

        expect(joinBody).toContain("v_invite_code      text := upper(trim(coalesce(p_invite_code, '')))")
        expect(joinBody).toContain('WHERE  invite_code = v_invite_code')
        expect(lockIndex).toBeGreaterThan(-1)
        expect(statusGateIndex).toBeGreaterThan(lockIndex)
    })

    it('preserves already-started lineup rows when completing accepted trades', () => {
        const completeBody = latestFunctionDefinition('complete_accepted_trade_atomic')
        const deleteBlocks = [...completeBody.matchAll(/DELETE FROM weekly_lineups AS wl[\s\S]*?;\n/g)]
            .map((match) => match[0])

        expect(deleteBlocks).toHaveLength(2)
        for (const block of deleteBlocks) {
            expect(block).toContain("wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date")
            expect(block).toContain('AND NOT EXISTS')
            expect(block).toContain("g.status IN ('InProgress', 'Final')")
            expect(block).toContain('g.game_time IS NOT NULL AND g.game_time <= now()')
            expect(block).toContain('g.started_at IS NOT NULL AND g.started_at <= now()')
        }
    })

    it('records ownership-add history for carried-over and rookie-drafted roster rows', () => {
        const advanceBody = latestFunctionDefinition('advance_season_atomic')
        const rookieBody = latestFunctionDefinition('make_snake_pick_atomic')

        expect(advanceBody).toContain("acquired_via = 'carry_over'")
        expect(advanceBody).toContain("transaction_type,\n    occurred_at")
        expect(advanceBody).toContain("'carry_over'")
        expect(advanceBody).toContain('acquired_at')
        expect(rookieBody).toContain("'draft'")
        expect(rookieBody).toContain("'draft_won'")
        expect(rookieBody).toContain('v_now')
        expect(rosterOwnershipHistoryMigration).toContain("WHERE rp.acquired_via = 'carry_over'")
        expect(rosterOwnershipHistoryMigration).toContain("rt.transaction_type = 'carry_over'")
        expect(rosterOwnershipHistoryMigration).toContain("WHERE rp.acquired_via = 'draft'")
        expect(rosterOwnershipHistoryMigration).toContain("rt.transaction_type = 'draft_won'")
        expect(rookieDraftLedgerMigration).toContain('FROM snake_draft_picks AS pick')
        expect(rookieDraftLedgerMigration).toContain('JOIN drafts AS draft ON draft.id = pick.draft_id')
        expect(rookieDraftLedgerMigration).toContain('COALESCE(pick.picked_at, draft.started_at, draft.created_at, now())')
        expect(rookieDraftLedgerMigration).toContain('rt.transaction_type = \'draft_won\'')
        expect(rookieDraftLedgerMigration).toContain("CASE WHEN is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END")
        expect(rookieDraftLedgerMigration).toContain("CASE WHEN rp.is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END")
        expect(rookieDraftLedgerMigration).toContain("COALESCE(rp.acquired_at, now()) + interval '1 millisecond'")
    })

    it('treats carry-over rows as ownership-add transactions in read paths', () => {
        expect(read('lib/lineup/read.ts')).toContain("['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over']")
        expect(read('lib/transactions.ts')).toContain("'carry_over'")
        expect(read('lib/shared/transaction-labels.ts')).toContain("carry_over: 'Carried Over'")
    })

    it('enforces positive auction budgets at the SQL boundary', () => {
        const createBody = latestFunctionDefinition('create_league')
        const startBody = latestFunctionDefinition('start_auction_draft_atomic')

        expect(rookieDraftLedgerMigration).toContain('CHECK (auction_budget > 0)')
        expect(rookieDraftLedgerMigration).toContain('UPDATE public.leagues')
        expect(createBody).toContain('p_auction_budget IS NULL OR p_auction_budget <= 0')
        expect(createBody).toContain('auction_budget must be a positive integer')
        expect(startBody).toContain('v_league.auction_budget IS NULL OR v_league.auction_budget <= 0')
        expect(startBody).toContain('Auction budget must be a positive integer before starting a draft')
    })

    it('uses real league member join timestamps for auction draft order', () => {
        for (const migrationSrc of [scoringCronAuctionMigration, etSeasonYearMigration, rookieDraftLedgerMigration, lineupCurrentSeasonMigration]) {
            expect(migrationSrc).not.toContain('lm.created_at')
        }
        expect(lineupCurrentSeasonMigration).toContain('row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)')
        expect(lineupCurrentSeasonMigration).toContain('ORDER BY lm.joined_at ASC, lm.id ASC')
    })

    it('guards rookie activation against stale completed drafts', () => {
        const activateBody = latestFunctionDefinition('activate_rookie_draft_league_atomic')

        expect(activateBody).toContain('FOR UPDATE')
        expect(activateBody).toContain('AND is_current = true')
        expect(activateBody).toContain('v_draft.league_season_id <> v_current_season.id')
        expect(activateBody).toContain('FROM snake_draft_picks')
        expect(activateBody).toContain('AND player_id IS NULL')
        expect(activateBody).toContain("current_draft.draft_type = 'snake'::draft_type")
        expect(activateBody).toContain("'pending'::draft_status")
        expect(activateBody).toContain("'in_progress'::draft_status")
        expect(activateBody).toContain("'paused'::draft_status")
    })

    it('requires commissioner authority for direct rookie activation RPC calls', () => {
        const activateBody = latestFunctionDefinition('activate_rookie_draft_league_atomic')

        expect(activateBody).toContain('private.is_commissioner(v_draft.league_id)')
        expect(activateBody).toContain('Only the league commissioner can activate this rookie draft league.')
        expect(activateBody).toContain("USING ERRCODE = '42501'")
        expect(activateBody).not.toContain('Only league members can activate this rookie draft league.')
    })

    it('wraps lineup write RPCs with a current-season guard', () => {
        expect(lineupCurrentSeasonMigration).toContain('FUNCTION public.assert_current_league_season_for_lineup')
        expect(lineupCurrentSeasonMigration).toContain('AND is_current = true')
        expect(lineupCurrentSeasonMigration).toContain('Lineup changes can only target the current league season')
        expect(lineupCurrentSeasonMigration).toContain('RENAME TO set_player_slot_moves_atomic_unchecked_legacy')
        expect(lineupCurrentSeasonMigration).toContain('RENAME TO auto_set_lineup_atomic_unchecked_legacy')
        expect(lineupCurrentSeasonMigration).toContain('PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id)')
        expect(lineupCurrentSeasonMigration).toContain('REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic_unchecked_legacy')
        expect(lineupCurrentSeasonMigration).toContain('REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic_unchecked_legacy')
        expect(lineupCurrentSeasonMigration).toContain('GRANT EXECUTE ON FUNCTION public.set_player_slot_moves_atomic')
        expect(lineupCurrentSeasonMigration).toContain('GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic')
    })

    it('blocks season deactivation while waiver state is still pending', () => {
        expect(playoffWaiverSeasonMigration).toContain('FUNCTION public.assert_current_season_for_pending_waiver_claim')
        expect(playoffWaiverSeasonMigration).toContain('FUNCTION public.assert_current_season_for_uncleared_waiver_log')
        expect(playoffWaiverSeasonMigration).toContain('FUNCTION public.prevent_season_deactivation_with_pending_waivers')
        expect(playoffWaiverSeasonMigration).toContain('BEFORE INSERT OR UPDATE OF league_id, league_season_id, status ON public.waiver_claims')
        expect(playoffWaiverSeasonMigration).toContain('BEFORE INSERT OR UPDATE OF league_id, league_season_id, cleared_at ON public.waiver_wire_log')
        expect(playoffWaiverSeasonMigration).toContain('BEFORE UPDATE OF is_current ON public.league_seasons')
        expect(playoffWaiverSeasonMigration).toContain("NEW.status = 'pending'::waiver_claim_status")
        expect(playoffWaiverSeasonMigration).toContain('NEW.cleared_at IS NULL')
        expect(playoffWaiverSeasonMigration).toContain("claim.status = 'pending'::waiver_claim_status")
        expect(playoffWaiverSeasonMigration).toContain('log.cleared_at IS NULL')
        expect(playoffWaiverSeasonMigration).toContain('FOR UPDATE')
        expect(playoffWaiverSeasonMigration).toContain('Resolve pending waiver claims and waiver holds before advancing season.')
    })
})
