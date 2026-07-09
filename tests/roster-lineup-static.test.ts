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

describe('logic hardening source guards - lineup and roster locks', () => {
    it('caps Edge scoring week lookup to the last seeded week after the schedule ends', () => {
        const scoring = read('supabase/functions/_shared/scoring.ts')
        expect(scoring).toContain("from './weekPolicy.ts'")
        expect(scoring).toContain('resolveSeasonWeekNumber')
        expect(scoring).toContain("'current-or-previous'")
        expect(scoring).toContain("select('week_number, week_start, week_end')")

        const edgeScores = read('supabase/functions/_shared/syncScores.ts')
        expect(edgeScores).toContain('error: weekErr')
        expect(edgeScores).toContain('if (weekErr) throw weekErr')
    })

    it('uses exact ET midnight for lineup history transaction cutoffs', () => {
        const lineupRead = read('lib/lineup/read.ts')
        const coreDates = read('core/src/dates/index.ts')
        expect(lineupRead).toContain("import { endOfETDayUTC, todayET }")
        expect(coreDates).toContain("timeZoneName: 'longOffset'")
        expect(coreDates).toContain('newYorkOffsetMinutes')
        expect(coreDates).toContain('nextLocalMidnightAsUTC')
        expect(coreDates).toContain('return new Date(utcTime).toISOString()')
        expect(lineupRead).toContain(".gt('occurred_at', endOfETDayUTC(gameDate))")
        expect(lineupRead).not.toContain('newYorkOffsetMinutes')
        expect(lineupRead).not.toContain("T05:00:00Z'")
        expect(lineupRead).not.toContain('~1h fuzz')
    })

    it('aborts auto-set before replacement RPC when lineup source reads fail', () => {
        const autoSet = read('lib/lineup/autoSet.ts')
        const rpcIndex = autoSet.indexOf("rpc('auto_set_lineup_atomic'")

        for (const guard of [
            'if (weeksErr) throw weeksErr',
            'if (rosterErr) throw rosterErr',
            'if (templatesErr) throw templatesErr',
            'if (gamesErr) throw gamesErr',
            'if (existingErr) throw existingErr',
        ]) {
            const guardIndex = autoSet.indexOf(guard)
            expect(guardIndex).toBeGreaterThan(-1)
            expect(guardIndex).toBeLessThan(rpcIndex)
        }

        const projectionReadIndex = autoSet.indexOf('const projectionMap = await getProjectionMap')
        expect(projectionReadIndex).toBeGreaterThan(-1)
        expect(projectionReadIndex).toBeLessThan(rpcIndex)
    })

    it('parses current NBA schedule tipoff fields in Edge', () => {
        const src = read('supabase/functions/_shared/nba.ts')
        expect(src).toContain('parseNBAScheduleGame')
        expect(src).toContain('gameDateTimeUTC')
        expect(src).toContain('gameDateTimeEst')
        expect(src).toContain('gameEt')
        expect(src).toContain('startedAt: firstString(g.gameDateTimeUTC, g.gameDateTimeEst, g.gameEt)')
        expect(src).toContain('weekNumber?: unknown')
        expect(src).toContain("weekNumber: typeof g.weekNumber === 'number' ? g.weekNumber : null")
        expect(src).toContain('scheduleSeasonYear')
    })

    it('shows cumulative max possible in app standings', () => {
        const appScoring = read('lib/scoring.ts')
        const leagueSections = read('components/league/LeagueStandings.tsx')
        expect(appScoring).toContain('home_max_possible_points, away_max_possible_points')
        expect(appScoring).toContain('const hMax = Number(m.home_max_possible_points ?? 0)')
        expect(appScoring).toContain('const aMax = Number(m.away_max_possible_points ?? 0)')
        expect(appScoring).toContain('map[m.home_member_id].maxPointsFor += hMax')
        expect(appScoring).toContain('map[m.away_member_id].maxPointsFor += aMax')
        expect(appScoring).toContain('ties: number')
        expect(appScoring).toContain('map[m.home_member_id].ties++')
        expect(appScoring).toContain('map[m.away_member_id].ties++')
        expect(appScoring).toContain('export function compareStandingsRows')
        expect(appScoring).toContain('b.maxPointsFor - a.maxPointsFor')
        expect(appScoring).toContain('a.pointsAgainst - b.pointsAgainst')
        expect(leagueSections).toContain('compareStandingsRows')
        expect(leagueSections).not.toContain('function compareStandingsRows')
        expect(leagueSections).toContain('{item.ties}')
        expect(leagueSections).toContain('>T</Text>')
        expect(appScoring).not.toContain('maxPointsFor = hp')
        expect(appScoring).not.toContain('maxPointsFor = ap')
    })

    it('requires explicit draft-order seasonYear outside the June/July cron window', () => {
        const src = read('supabase/functions/sync-draft-order/index.ts')
        expect(src).toContain('defaultDraftOrderSeasonYear')
        expect(src).toContain('month !== 6 && month !== 7')
        expect(src).toContain('seasonYear is required outside the June/July draft-order sync window')
    })

    it('preserves already-started lineup rows during roster drop, waiver, IR, and taxi cleanup', () => {
        for (const rel of [
            'supabase/migrations/20260606000022_roster_toggles_lock_order.sql',
            'supabase/migrations/20260606000023_drop_player_lock_order.sql',
            'supabase/migrations/20260606000020_waiver_clears_live_poll_cdn_ledger.sql',
        ]) {
            const src = read(rel)
            expect(src).toMatch(/DELETE FROM weekly_lineups(?: AS)? wl/)
            expect(src).toContain('AND NOT EXISTS')
            expect(src).toContain("g.status IN ('InProgress', 'Final')")
            expect(src).toContain('g.game_time IS NOT NULL AND g.game_time <= now()')
            expect(src).toContain('g.started_at IS NOT NULL AND g.started_at <= now()')
        }

        expect(waiverMigration.match(/AND NOT EXISTS/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    })

    it('enforces started-game locks inside IR and taxi roster toggle RPCs', () => {
        const toggleMigration = read('supabase/migrations/20260606000022_roster_toggles_lock_order.sql')
        const edgeLeague = read('supabase/functions/api/league.ts')
        const irBody = toggleMigration.slice(
            toggleMigration.indexOf('FUNCTION public.toggle_ir_atomic'),
            toggleMigration.indexOf('REVOKE ALL ON FUNCTION public.toggle_ir_atomic'),
        )
        const taxiBody = toggleMigration.slice(
            toggleMigration.indexOf('FUNCTION public.toggle_taxi_atomic'),
            toggleMigration.indexOf('REVOKE ALL ON FUNCTION public.toggle_taxi_atomic'),
        )

        for (const body of [irBody, taxiBody]) {
            const lockIndex = body.indexOf('Player game has already started')
            const updateIndex = body.indexOf('UPDATE roster_players')
            expect(lockIndex).toBeGreaterThan(-1)
            expect(updateIndex).toBeGreaterThan(lockIndex)
            expect(body).toContain("g.game_date >= ((now() AT TIME ZONE 'America/New_York')::date - 1)")
            expect(body).toContain("g.status = 'InProgress'")
            expect(body).toContain("AND g.status = 'Final'")
            expect(body).toContain('g.game_time IS NOT NULL AND g.game_time <= now()')
            expect(body).toContain('g.started_at IS NOT NULL AND g.started_at <= now()')
            expect(body).toContain("g.game_time >= now() - interval '12 hours'")
            expect(body).toContain("g.started_at >= now() - interval '12 hours'")
        }

        expect(edgeLeague).toContain('candidateDates = [addDaysToETDate(gameDate, -1), gameDate]')
        expect(edgeLeague).toContain('isRosterToggleLockedGame')
        expect(edgeLeague).toContain('recentWindowStart')
        expect(edgeLeague).toContain("game.status === 'InProgress'")
        expect(edgeLeague).toContain("game.game_date === today && game.status === 'Final'")
    })

    it('uses one transaction when activating IR or taxi players into lineup slots', () => {
        const hook = read('hooks/use-lineup-actions.ts')
        const movePlan = read('lib/lineup/movePlan.ts')
        const roster = read('lib/roster.ts')
        const rpc = latestFunctionDefinition('activate_roster_player_with_lineup_atomic')

        expect(hook).toContain('activateRosterPlayerWithLineup')
        expect(hook).toContain('planLineupMove')
        expect(hook).toContain('slotType: plan.slotType')
        expect(hook).toContain('slotType: activationOverflowPending.slotType')
        expect(movePlan).toContain("activateSource: 'ir'")
        expect(movePlan).toContain("activateSource: 'taxi'")
        expect(movePlan).toContain('slotType: activationSlotType(lineup, activeSelection, irPlayer)')
        expect(movePlan).toContain('slotType: activationSlotType(lineup, activeSelection, taxiPlayer)')
        expect(hook).not.toContain('await setPlayerSlot(')
        expect(hook).not.toContain('await toggleIR(irPlayer.rosterPlayerId, false)')
        expect(hook).not.toContain('await toggleTaxi(taxiPlayer.rosterPlayerId, false)')

        expect(roster).toContain("supabase.rpc('activate_roster_player_with_lineup_atomic'")
        expect(rpc).toContain('PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id)')
        expect(rpc).toContain('PERFORM public.toggle_taxi_atomic(p_free_roster_player_id, true, v_user_id)')
        expect(rpc).toContain('PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id)')
        expect(rpc).toContain('PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id)')
        expect(rpc).toContain('PERFORM public.set_player_slot_atomic')
        expect(rpc.indexOf('PERFORM public.set_player_slot_atomic')).toBeGreaterThan(
            rpc.indexOf('PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id)'),
        )
    })

    it('drops stale async results before committing trade and lineup state', () => {
        const trade = read('app/(modals)/propose-trade.tsx')
        const lineup = read('app/(modals)/lineup.tsx')

        const tradeRequestIndex = trade.indexOf('const requestId = ++rosterLoadSeqRef.current')
        const tradeCommitGuardIndex = trade.indexOf('if (rosterLoadSeqRef.current !== requestId) return', trade.indexOf('Promise.all'))
        const tradeCommitIndex = trade.indexOf('setTheirRoster(theirActiveRoster)')
        expect(tradeRequestIndex).toBeGreaterThan(-1)
        expect(tradeCommitGuardIndex).toBeGreaterThan(tradeRequestIndex)
        expect(tradeCommitGuardIndex).toBeLessThan(tradeCommitIndex)
        expect(trade).toContain('if (rosterLoadSeqRef.current === requestId) setRosterLoading(false)')

        expect(lineup).toContain('lineupLoadSeqRef')
        expect(lineup).toContain('lineupError')
        expect(lineup).toContain('Retry lineup load')
        expect(lineup).toContain('if (lineupLoadSeqRef.current !== requestId) return false')
        expect(lineup).toContain("lineupError\n              ? 'Could not load lineup.'")
    })
})
