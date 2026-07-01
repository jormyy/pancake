import { describe, expect, it } from 'vitest'
import { functionPrivilegeStatements, latestFunctionDefinition, migrationsFrom, read, sources } from './source-guard'

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
    rookieDraftTimerMigration,
    draftConfigMockMigration,
} = sources
const draftPauseResumeAuditMigration = read('supabase/migrations/20260630000004_draft_pause_resume_audit.sql')
const timerExpiryMigrationRange = migrationsFrom('20260630000008')

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
        const rookieBody = latestFunctionDefinition('make_snake_pick_atomic_internal', 'private')

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
        expect(startBody).toContain('v_budget := COALESCE(p_budget_per_team, v_league.auction_budget)')
        expect(startBody).toContain('v_budget IS NULL OR v_budget <= 0')
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
        const activationHelperBody = latestFunctionDefinition('activate_rookie_draft_league_if_ready', 'private')

        expect(activateBody).toContain('FOR UPDATE')
        expect(activateBody).toContain('private.activate_rookie_draft_league_if_ready')
        expect(activationHelperBody).toContain('AND is_current = true')
        expect(activationHelperBody).toContain('v_draft.league_season_id <> v_current_season.id')
        expect(activationHelperBody).toContain('FROM snake_draft_picks')
        expect(activationHelperBody).toContain('AND player_id IS NULL')
        expect(activationHelperBody).toContain("current_draft.draft_type = 'snake'::draft_type")
        expect(activationHelperBody).toContain("'pending'::draft_status")
        expect(activationHelperBody).toContain("'in_progress'::draft_status")
        expect(activationHelperBody).toContain("'paused'::draft_status")
    })

    it('audits commissioner stop/reset and allows reset recovery from terminal statuses', () => {
        const stopBody = latestFunctionDefinition('stop_draft_atomic')
        const resetBody = latestFunctionDefinition('reset_draft_atomic')

        expect(stopBody).toContain('p_actor_user_id uuid DEFAULT NULL')
        expect(stopBody).toContain("v_draft.status NOT IN ('pending', 'in_progress', 'paused')")
        expect(stopBody).toContain('INSERT INTO draft_audit_logs')
        expect(stopBody).toContain("'stop'")

        expect(resetBody).toContain('p_actor_user_id uuid DEFAULT NULL')
        expect(resetBody).toContain("v_draft.status NOT IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled')")
        expect(resetBody).toContain('related_nomination_id IN')
        expect(resetBody).toContain("transaction_type = 'draft_won'")
        expect(resetBody).toContain('private.arm_next_snake_pick_timer')
        expect(resetBody).toContain('playersRemoved')
        expect(resetBody).toContain("'reset'")
    })

    it('adds pause/resume draft RPCs with audit rows and service-role-only execution', () => {
        const pauseBody = latestFunctionDefinition('pause_draft_atomic')
        const resumeBody = latestFunctionDefinition('resume_draft_atomic')

        expect(draftPauseResumeAuditMigration).toContain('CREATE TABLE IF NOT EXISTS public.draft_audit_logs')
        expect(draftPauseResumeAuditMigration).toContain('private.is_league_member(league_id)')
        expect(draftPauseResumeAuditMigration).toContain('timer_paused_remaining_seconds')
        expect(pauseBody).toContain("v_draft.status <> 'in_progress'")
        expect(pauseBody).toContain('countdown_expires_at = NULL')
        expect(pauseBody).toContain('timer_expires_at = NULL')
        expect(pauseBody).toContain("pause_reason = 'manual'")
        expect(pauseBody).toContain("'pause'")
        expect(resumeBody).toContain("v_draft.status <> 'paused'")
        expect(resumeBody).toContain('make_interval(secs => v_remaining_seconds)')
        expect(resumeBody).toContain('private.arm_next_snake_pick_timer')
        expect(resumeBody).toContain('pause_reason = NULL')
        expect(resumeBody).toContain("'resume'")
        expect(functionPrivilegeStatements('pause_draft_atomic').some((stmt) => stmt.includes('TO service_role'))).toBe(true)
        expect(functionPrivilegeStatements('resume_draft_atomic').some((stmt) => stmt.includes('TO service_role'))).toBe(true)
    })

    it('keeps rookie pick clocks server-authoritative through SQL and Edge cron', () => {
        const armTimerBody = latestFunctionDefinition('arm_next_snake_pick_timer', 'private')
        const startBody = latestFunctionDefinition('start_rookie_draft_atomic')
        const pickBody = latestFunctionDefinition('make_snake_pick_atomic_internal', 'private')
        const batchBody = latestFunctionDefinition('process_expired_snake_picks_atomic')
        const edgeCron = read('supabase/functions/close-expired-nominations/index.ts')
        const rookieState = read('lib/rookieDraft.ts')
        const rookieRoom = read('app/(modals)/rookie-draft-room.tsx')
        const controller = read('hooks/useRookieDraftRoomController.ts')

        expect(rookieDraftTimerMigration).toContain('ADD COLUMN IF NOT EXISTS timer_expires_at')
        expect(timerExpiryMigrationRange).toContain('DROP INDEX IF EXISTS public.idx_snake_draft_picks_expiring_timer')
        expect(timerExpiryMigrationRange).toContain('idx_snake_draft_picks_active_timer')
        expect(armTimerBody).toContain('SET timer_expires_at = p_expires_at')
        expect(armTimerBody).toContain('AND skipped_at IS NULL')
        expect(armTimerBody).toContain('RETURNING timer_expires_at')
        expect(startBody).toContain('private.arm_next_snake_pick_timer')
        expect(pickBody).toContain('timer_expires_at = NULL')
        expect(pickBody).toContain('private.arm_next_snake_pick_timer')
        expect(batchBody).toContain('pick.timer_expires_at < now()')
        expect(batchBody).toContain('private.arm_next_snake_pick_timer')
        expect(batchBody).toContain("public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired')")
        expect(edgeCron).toContain('process_expired_snake_picks_atomic')
        expect(edgeCron).toContain('autoPicked')
        expect(rookieState).toContain('timer_expires_at')
        expect(rookieState).toContain('timerExpiresAt')
        expect(controller).toContain('refresh: load')
        expect(rookieRoom).toContain('await refresh()')
        expect(controller).toContain('state.nextPick.timerExpiresAt')
        expect(controller).toContain("state.draft.timerExpiryBehavior !== 'auto_pick'")
        expect(controller).toContain('await processExpiredSnakePick(draftId, stableMemberId)')
        expect(controller).not.toContain('await autoPickBest(draftId, stableMemberId)')
        expect(controller).not.toContain('PICK_TIMEOUT_SEC')
        expect(read('lib/rookieDraft.ts')).toContain('process-expired-pick')
        expect(read('types/database.ts')).toContain('process_expired_snake_picks_atomic')
        expect(read('types/database.ts')).toContain('process_expired_snake_pick_atomic')
    })

    it('keeps rookie timeout behavior configurable and server-enforced', () => {
        const armTimerBody = latestFunctionDefinition('arm_next_snake_pick_timer', 'private')
        const startBody = latestFunctionDefinition('start_rookie_draft_atomic')
        const pickBody = latestFunctionDefinition('make_snake_pick_atomic_internal', 'private')
        const publicPickBody = latestFunctionDefinition('make_snake_pick_atomic')
        const resetBody = latestFunctionDefinition('reset_draft_atomic')
        const resumeBody = latestFunctionDefinition('resume_draft_atomic')
        const stopBody = latestFunctionDefinition('stop_draft_atomic')
        const activateBody = latestFunctionDefinition('activate_rookie_draft_league_atomic')
        const activationHelperBody = latestFunctionDefinition('activate_rookie_draft_league_if_ready', 'private')
        const completeHelperBody = latestFunctionDefinition('complete_rookie_draft_if_ready', 'private')
        const autoPickBody = latestFunctionDefinition('auto_pick_snake_pick_atomic')
        const processExpiredPickBody = latestFunctionDefinition('process_expired_snake_pick_atomic')
        const commissionerPickBody = latestFunctionDefinition('commissioner_snake_pick_atomic')
        const batchBody = latestFunctionDefinition('process_expired_snake_picks_atomic')
        const rookieState = read('lib/rookieDraft.ts')
        const controller = read('hooks/useRookieDraftRoomController.ts')
        const api = read('supabase/functions/api/draft.ts')
        const leagueScreen = read('app/(tabs)/league.tsx')
        const rookieRoom = read('app/(modals)/rookie-draft-room.tsx')
        const databaseTypes = read('types/database.ts')

        expect(timerExpiryMigrationRange).toContain('timer_expiry_behavior')
        expect(timerExpiryMigrationRange).toContain('ADD COLUMN IF NOT EXISTS pause_reason text')
        expect(timerExpiryMigrationRange).toContain('drafts_pause_reason_known')
        expect(timerExpiryMigrationRange).toContain('skipped_at timestamptz')
        expect(startBody).toContain('p_timer_expiry_behavior text DEFAULT')
        expect(startBody).toContain("'skip_pick', 'pause_draft', 'commissioner_pick'")
        expect(publicPickBody).toContain('private.make_snake_pick_atomic_internal')
        expect(publicPickBody).toContain('false')
        expect(pickBody).toContain('p_allow_expired_timer')
        expect(pickBody).toContain('v_next_pick.timer_expires_at <= v_now')
        expect(pickBody).toContain('Pick timer has expired')
        expect(pickBody).toContain('AND skipped_at IS NULL')
        expect(resetBody).toContain('skipped_at = NULL')
        expect(resetBody).toContain('pause_reason = NULL')
        expect(stopBody).toContain('pause_reason = NULL')
        expect(resetBody).toContain('private.arm_next_snake_pick_timer')
        expect(armTimerBody).toContain('AND skipped_at IS NULL')
        expect(resumeBody).toContain('private.arm_next_snake_pick_timer')
        expect(resumeBody).toContain('pause_reason = NULL')
        expect(resumeBody).toContain("v_draft.pause_reason = 'timer_expired_commissioner_pick'")
        expect(activationHelperBody).toContain('AND skipped_at IS NULL')
        expect(completeHelperBody).toContain('pause_reason = NULL')
        expect(batchBody).toContain("v_draft.timer_expiry_behavior = 'skip_pick'")
        expect(batchBody).toContain("skip_reason = 'timer_expired'")
        expect(batchBody).toContain('pg_try_advisory_xact_lock')
        expect(batchBody).not.toContain('FOR UPDATE OF pick SKIP LOCKED')
        expect(batchBody).toContain('current_owner_id = v_pick.member_id')
        expect(batchBody).toContain('round = v_pick.round')
        expect(batchBody).toContain("public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired')")
        expect(batchBody).toContain('private.complete_rookie_draft_if_ready')
        expect(batchBody).toContain('pause_reason = CASE')
        expect(timerExpiryMigrationRange).toContain('private.activate_rookie_draft_league_if_ready')
        expect(timerExpiryMigrationRange).toContain('CREATE OR REPLACE FUNCTION public.commissioner_snake_pick_atomic')
        expect(batchBody).toContain("'timer_expired_pause'")
        expect(batchBody).toContain("'timer_expired_commissioner_pick'")
        expect(commissionerPickBody).toContain("v_draft.pause_reason IS DISTINCT FROM 'timer_expired_commissioner_pick'")
        expect(commissionerPickBody).toContain('pause_reason = NULL')
        expect(autoPickBody).toContain('private.make_snake_pick_atomic_internal')
        expect(autoPickBody).toContain("v_reason = 'timer_expired'")
        expect(autoPickBody).not.toContain("COALESCE(v_draft.timer_expiry_behavior, 'auto_pick') = 'auto_pick'")
        expect(autoPickBody).toContain("'auto_pick'")
        expect(processExpiredPickBody).toContain("public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired')")
        expect(processExpiredPickBody).toContain('p_draft_id uuid')
        expect(rookieState).toContain('timerExpiryBehavior')
        expect(rookieState).toContain('pauseReason')
        expect(rookieState).toContain('skippedAt')
        expect(controller).toContain('commissionerSnakePick')
        expect(controller).toContain('autoPickAttemptRef')
        expect(api).toContain('timerExpiryBehavior: rookieTimerExpiryBehavior(body)')
        expect(api).toContain("supabase.rpc('auto_pick_snake_pick_atomic'")
        expect(api).toContain("supabase.rpc('process_expired_snake_pick_atomic'")
        expect(api).toContain("action.action === 'process-expired-pick'")
        expect(api).toContain('nextPick.member_id !== memberId')
        expect(api).toContain("action.action === 'activate-rookie-league'")
        expect(api).toContain('requireDraftLeagueMember')
        expect(api).toContain("supabase.rpc('activate_rookie_draft_league_atomic'")
        expect(api).toContain("action.action === 'commissioner-pick'")
        expect(leagueScreen).toContain('Timeout behavior')
        expect(leagueScreen).toContain('ROOKIE_TIMER_EXPIRY_BEHAVIORS')
        expect(rookieRoom).toContain('pickSkipped')
        expect(rookieRoom).toContain("draft.pauseReason === 'timer_expired_commissioner_pick'")
        expect(rookieRoom).toContain('const canUsePauseControl = !canCommissionerPick')
        expect(rookieRoom).toContain('const pickTimerExpired')
        expect(rookieRoom).toContain('isDone || pickTimerExpired')
        expect(rookieRoom).toContain('Commissioner Pick Needed')
        expect(databaseTypes).toContain('timer_expiry_behavior')
        expect(databaseTypes).toContain('pause_reason')
        expect(databaseTypes).toContain('skipped_at')
    })

    it('supports configurable real drafts and side-effect-free mock drafts', () => {
        const startAuctionBody = latestFunctionDefinition('start_auction_draft_atomic')
        const startRookieBody = latestFunctionDefinition('start_rookie_draft_atomic')
        const snakePickBody = latestFunctionDefinition('make_snake_pick_atomic_internal', 'private')
        const closeAuctionBody = latestFunctionDefinition('close_auction_nomination_atomic')
        const api = read('supabase/functions/api/draft.ts')
        const draftLib = read('lib/draft.ts')
        const leagueScreen = read('app/(tabs)/league.tsx')

        expect(draftConfigMockMigration).toContain('ADD COLUMN IF NOT EXISTS is_mock boolean')
        expect(draftConfigMockMigration).toContain('ADD COLUMN IF NOT EXISTS pick_timer_seconds int')
        expect(draftConfigMockMigration).toContain('WHERE status IN (\'pending\', \'in_progress\') AND is_mock = false')
        expect(startAuctionBody).toContain('p_is_mock boolean DEFAULT false')
        expect(startAuctionBody).toContain('p_pick_timer_seconds int DEFAULT 30')
        expect(startAuctionBody).toContain('p_budget_per_team int DEFAULT NULL')
        expect(startAuctionBody).toContain('IF NOT v_is_mock AND v_league.status IS DISTINCT FROM')
        expect(startAuctionBody).toContain('IF NOT v_is_mock THEN')
        expect(startRookieBody).toContain('p_rounds int DEFAULT 3')
        expect(startRookieBody).toContain('p_is_mock boolean DEFAULT false')
        expect(startRookieBody).toContain('p_pick_timer_seconds int DEFAULT 30')
        expect(startRookieBody).toContain('draft_pick_id')
        expect(startRookieBody).toContain('NULL')
        expect(snakePickBody).toContain('IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL')
        expect(snakePickBody).toContain('IF NOT v_draft.is_mock THEN')
        expect(closeAuctionBody).toContain('IF NOT v_draft.is_mock THEN')
        expect(closeAuctionBody).toContain("transaction_type,\n          related_nomination_id")
        expect(api).toContain('auctionDraftStartOptions')
        expect(api).toContain('rookieDraftStartOptions')
        expect(api).toContain('timerSeconds')
        expect(api).toContain("optionalBooleanField(body, 'isMock') ?? false")
        expect(api).not.toContain('body.isMock === true')
        expect(draftLib).toContain(".in('status', ['in_progress', 'pending', 'paused'])")
        expect(draftLib).not.toContain(".in('status', ['in_progress', 'pending', 'paused', 'completed'])")
        expect(draftLib).toContain('getJoinableDraft')
        expect(draftLib).toContain('includeCompletedRookie')
        expect(draftLib).toContain(".from('leagues')")
        expect(draftLib).toContain("league?.status !== 'drafting'")
        expect(draftLib).toContain(".eq('draft_type', 'snake')")
        expect(draftLib).toContain(".eq('status', 'completed')")
        expect(draftLib).toContain(".eq('is_mock', false)")
        expect(leagueScreen).not.toContain("includeCompletedRookie: currentLeague.status === 'drafting'")
        expect(leagueScreen).toContain('Start Mock Auction')
        expect(leagueScreen).toContain('Start Mock Rookie Draft')
        expect(leagueScreen).toContain('OPEN_DRAFT_STATUSES')
        expect(leagueScreen).toContain('getJoinableDraft')
        expect(leagueScreen).toContain('Resolve Rookie Draft')
        expect(leagueScreen).toContain('includeCompletedRookie: true')
        expect(leagueScreen).toContain('const draft = activeDraft ?? await getJoinableDraft(currentLeague.id')
        expect(leagueScreen).toContain('activeDraftButtonLabel')
        expect(leagueScreen).toContain("draft.isMock ? 'Mock ' : ''")
        expect(leagueScreen).toContain('activeDraft.draftType === \'snake\' && !activeDraft.isMock && isCommissioner')
        expect(leagueScreen).toContain('{renderDraftActions()}')
        expect(read('types/database.ts')).toContain('pick_timer_seconds')
        expect(read('types/database.ts')).toContain('p_is_mock?: boolean')
    })

    it('requires commissioner authority for direct rookie activation RPC calls', () => {
        const activateBody = latestFunctionDefinition('activate_rookie_draft_league_atomic')
        const rookieLib = read('lib/rookieDraft.ts')

        expect(activateBody).toContain('private.is_commissioner(v_draft.league_id)')
        expect(activateBody).toContain('Only the league commissioner can activate this rookie draft league.')
        expect(activateBody).toContain("USING ERRCODE = '42501'")
        expect(activateBody).not.toContain('Only league members can activate this rookie draft league.')
        expect(rookieLib).toContain('activate-rookie-league')
        expect(rookieLib).not.toContain("supabase.rpc('activate_rookie_draft_league_atomic'")
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
