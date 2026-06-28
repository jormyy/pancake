import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, latestTriggerStatement, read, sources } from './source-guard'

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

describe('logic hardening source guards - scoring, playoffs, schedule', () => {
    it('uses paged weekly scoring reads and legal active-roster lineup optimization for max possible', () => {
        for (const rel of [
            'backend/src/sync/scoreLineups.ts',
            'supabase/functions/_shared/scoreLineups.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('fetchAllPages')
            expect(src).toContain("const ROSTER_ADD_TRANSACTION_TYPES = ['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over']")
            expect(src).toContain("from('lineup_slot_templates')")
            expect(src).toContain('SLOT_ALLOWED_POSITIONS')
            expect(src).toContain('bestLineupPointsForDate')
            expect(src).toContain('loadActualLineupPointsInput')
            expect(src).toContain('loadMaxPossiblePointsInput')
            expect(src).not.toContain('loadWeekLineupAndPlayerPoints')
            expect(src).not.toContain('includeBench')
            expect(src).toContain("from('roster_players')")
            expect(src).toContain("from('roster_transactions')")
            expect(src).toContain('ROSTER_ADD_TRANSACTION_TYPES')
            expect(src).toContain('ROSTER_DROP_TRANSACTION_TYPES')
            expect(src).toContain('ROSTER_INACTIVE_TRANSACTION_TYPES')
            expect(src).toContain('buildRosterEligibilityAtCutoff')
            expect(src).toContain('latestAvailabilityAfterOwnership')
            expect(src).toContain('statRosterCutoff')
            expect(src).toContain('endOfETDayUTC')
            expect(src).toContain('nba_games!inner(nba_game_id,game_time,started_at)')
            expect(src).toContain(".in('transaction_type', ROSTER_HISTORY_TRANSACTION_TYPES)")
            expect(src).toContain(".lte('occurred_at', endOfETDayUTC(weekEnd))")
            expect(src).toContain('players(position, eligible_positions)')
            expect(src).toContain("eq('is_on_ir', false)")
            expect(src).toContain("eq('is_on_taxi', false)")
            expect(src).toContain(".order('member_id')")
            expect(src).toContain(".order('player_id')")
            expect(src).toContain(".order('id')")
            expect(src).toContain('new Map<string, Map<string, LineupCandidate[]>>()')
            expect(src).not.toContain("key.startsWith(`${memberId}|`)")
            expect(src).not.toContain('T05:00:00Z')
            expect(src).not.toContain('scoresByPlayer')
        }
        for (const rel of [
            'backend/src/sync/scoreShared.ts',
            'supabase/functions/_shared/scoreShared.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('fetchAllPages')
            expect(src).toContain('endOfETDayUTC')
            expect(src).toContain("timeZoneName: 'longOffset'")
            expect(src).not.toContain('T05:00:00Z')
        }
        for (const rel of [
            'backend/src/sync/scores.ts',
            'supabase/functions/_shared/syncScores.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('const { error: updateErr } = await supabase')
            expect(src).toContain('if (updateErr) throw updateErr')
        }
    })

    it('surfaces stat sync failures before any final scoring pass can freeze standings', () => {
        for (const rel of [
            'backend/src/sync/stats.ts',
            'supabase/functions/_shared/syncStats.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('const syncFailures: string[] = []')
            expect(src).toContain('syncFailures.push')
            expect(src).toContain('throw new Error')
        }
    })

    it('skips stale past scheduled CDN box scores before persisting stats in backend and Edge', () => {
        for (const rel of [
            'backend/src/sync/stats.ts',
            'supabase/functions/_shared/syncStats.ts',
        ]) {
            const src = read(rel)
            const fetchIndex = src.indexOf('fetchBoxScore')
            const staleScheduledGuardIndex = src.indexOf('if (isPast && boxScore.gameStatus === 1) continue')
            const statsWriteIndex = src.indexOf("from('player_game_stats')")

            expect(src).toContain("like('nba_game_id', '002%')")
            expect(src).toContain("query.neq('status', 'Scheduled')")
            expect(staleScheduledGuardIndex).toBeGreaterThan(fetchIndex)
            expect(statsWriteIndex).toBeGreaterThan(staleScheduledGuardIndex)
        }
    })

    it('generates playoff brackets only from finalized regular-season state', () => {
        const src = read('backend/src/sync/playoffs.ts')
        const generatorBody = src.slice(
            src.indexOf('export async function generateSemifinals'),
            src.indexOf('/**', src.indexOf('export async function generateSemifinals') + 1),
        )
        const assertIndex = generatorBody.indexOf('await assertRegularSeasonFinalized')
        const idempotencyIndex = generatorBody.indexOf('const { count, error: playoffCountErr } = await supabase')

        expect(src).toContain('async function assertRegularSeasonFinalized')
        expect(src).toContain(".lt('week_number', playoffStartWeek)")
        expect(src).toContain(".eq('is_finalized', false)")
        expect(src).toContain('Regular season matchups must be finalized before generating playoffs.')
        expect(src).toContain(".eq('is_finalized', true)")
        expect(src).toContain('if (playoffCountErr) throw playoffCountErr')
        expect(src).toContain('if (finalCountErr) throw finalCountErr')
        expect(src).toContain('if (semiCountErr) throw semiCountErr')
        expect(assertIndex).toBeGreaterThan(-1)
        expect(idempotencyIndex).toBeGreaterThan(assertIndex)
    })

    it('records deterministic playoff tiebreakers and blocks unscorable playoff weeks', () => {
        const src = read('backend/src/sync/playoffs.ts')
        const generatorBody = src.slice(
            src.indexOf('export async function generateSemifinals'),
            src.indexOf('/**', src.indexOf('export async function generateSemifinals') + 1),
        )
        const weekCheckIndex = generatorBody.indexOf('await assertPlayoffWeeksAvailable')
        const auditIndex = generatorBody.indexOf('await recordTiebreakerAuditRows')
        const insertIndex = generatorBody.indexOf("from('matchups').insert")

        expect(src).toContain('createHash')
        expect(src).toContain('function deterministicTiebreakerToken')
        expect(src).toContain('function comparePlayoffSeeds')
        expect(src).toContain('function relevantTiebreakerPairs')
        expect(src).toContain('const groupOverlapsPlayoffField = index < playoffSize')
        expect(src).toContain('if (!groupOverlapsPlayoffField) break')
        expect(src).not.toContain('seeds.slice(0, playoffSize + 1)')
        expect(src).toContain('winnerMemberId: comparePlayoffSeeds')
        expect(src).toContain("select('id, member_a_id, member_b_id, winner_member_id, status')")
        expect(src).toContain(".eq('context', 'standings_playoff_tiebreaker')")
        expect(src).toContain("status: 'completed' as const")
        expect(src).toContain('resolved_at: resolvedAt')
        expect(src).not.toContain('Resolve playoff RPS tiebreakers before generating playoffs.')
        expect(src).toContain('async function assertPlayoffWeeksAvailable')
        expect(src).toContain("from('season_weeks')")
        expect(src).toContain(".order('week_number', { ascending: false })")
        expect(src).toContain('playoffStartWeek + playoffRounds - 1')
        expect(src).toContain('Playoff start week does not leave enough season weeks')
        expect(weekCheckIndex).toBeGreaterThan(-1)
        expect(auditIndex).toBeGreaterThan(weekCheckIndex)
        expect(insertIndex).toBeGreaterThan(auditIndex)
    })

    it('prevents saved playoff starts that cannot fit a three-round bracket', () => {
        const commissionerSettings = read('app/(modals)/commissioner-settings.tsx')
        expect(playoffWaiverSeasonMigration).toContain('playoff_start_week = 24')
        expect(playoffWaiverSeasonMigration).toContain('CHECK (playoff_start_week BETWEEN 18 AND 24)')
        expect(playoffWaiverSeasonMigration).toContain('idx_rps_standings_playoff_tiebreaker_pair')
        expect(playoffWaiverSeasonMigration).toContain("WHERE context = 'standings_playoff_tiebreaker'")
        expect(playoffWaiverSeasonMigration).toContain('LEAST(member_a_id, member_b_id)')
        expect(playoffWaiverSeasonMigration).toContain('GREATEST(member_a_id, member_b_id)')
        expect(commissionerSettings).toContain('parsedPlayoff > 24')
        expect(commissionerSettings).toContain('Playoff start week must be between 18 and 24')
    })

    it('anchors playoff advancement to stored bracket weeks after generation', () => {
        const src = read('backend/src/sync/playoffs.ts')
        const playoffGuardBody = latestFunctionDefinition('prevent_playoff_start_week_change_after_bracket')
        const playoffGuardTrigger = latestTriggerStatement('prevent_playoff_start_week_change_after_bracket')

        expect(src).toContain("select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')")
        expect(src).toContain('const quarterfinalWeek = Math.min')
        expect(src).toContain('week_number: quarterfinalWeek + 1')
        expect(src).toContain("select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')")
        expect(src).toMatch(/eq\('matchup_type', 'playoff_semifinal'\)[\s\S]*?order\('created_at', \{ ascending: true \}\)[\s\S]*?order\('id', \{ ascending: true \}\)/)
        expect(src).toContain('const finalWeek = Math.max')
        expect(src).toContain('week_number: finalWeek')
        expect(src).not.toContain('playoffStartWeek + ((quarterfinals')
        expect(playoffGuardTrigger).toContain('BEFORE UPDATE OF playoff_start_week ON public.leagues')
        expect(playoffGuardTrigger).toContain('WHEN (OLD.playoff_start_week IS DISTINCT FROM NEW.playoff_start_week)')
        expect(playoffGuardBody).toContain('JOIN league_seasons AS season')
        expect(playoffGuardBody).toContain('season.is_current = true')
        expect(playoffGuardBody).toContain('WHERE matchup.league_id = OLD.id')
        expect(playoffGuardBody).toContain('Playoff start week cannot be changed after current-season matchups have been generated.')
    })

    it('rejects trade acceptance after the trade deadline', () => {
        const tradeGuardBody = latestFunctionDefinition('prevent_trade_acceptance_after_deadline')
        const tradeGuardTrigger = latestTriggerStatement('prevent_trade_acceptance_after_deadline')

        expect(tradeGuardTrigger).toContain('BEFORE UPDATE OF status ON public.trades')
        expect(tradeGuardTrigger).toContain("WHEN (OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status)")
        expect(tradeGuardBody).toContain("v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date")
        expect(tradeGuardBody).toContain('Trade can no longer be accepted after the trade deadline.')
    })

    it('keeps current-schema playoff and trade-deadline guards effective after later migrations', () => {
        expect(latestFunctionDefinition('prevent_trade_acceptance_after_deadline')).toContain('v_trade_deadline')
        expect(latestTriggerStatement('prevent_trade_acceptance_after_deadline')).toContain('EXECUTE FUNCTION public.prevent_trade_acceptance_after_deadline()')
        expect(latestFunctionDefinition('prevent_playoff_start_week_change_after_bracket')).toContain('season.is_current = true')
        expect(latestTriggerStatement('prevent_playoff_start_week_change_after_bracket')).toContain('EXECUTE FUNCTION public.prevent_playoff_start_week_change_after_bracket()')
    })

    it('does not finalize weeks when pending-game reads fail', () => {
        for (const rel of [
            'backend/src/sync/scores.ts',
            'supabase/functions/_shared/syncScores.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('pendingGamesError')
            expect(src).toContain('if (pendingGamesError) throw pendingGamesError')
        }
    })

    it('runs final stat sync before final scoring when the live poller sees all games complete', () => {
        const livePoller = read('backend/src/sync/livePoller.ts')
        expect(livePoller).toContain('if (shouldSync && !allDone)')

        const allDoneBody = livePoller.slice(
            livePoller.indexOf('if (allDone) {'),
            livePoller.indexOf('const dates = Array.from'),
        )
        expect(allDoneBody.indexOf('syncStatsForCandidateDates')).toBeGreaterThan(-1)
        expect(allDoneBody.indexOf('syncScores')).toBeGreaterThan(allDoneBody.indexOf('syncStatsForCandidateDates'))
    })

    it('runs stat sync before manual score finalization', () => {
        const syncRoutes = read('backend/src/routes/sync.ts')
        const scoresBody = syncRoutes.slice(
            syncRoutes.indexOf("app.post('/scores'"),
            syncRoutes.indexOf("app.post('/schedule'"),
        )
        const edgeScores = read('supabase/functions/sync-scores/index.ts')

        expect(syncRoutes).toContain('syncStatsForScoreCandidateDates')
        expect(scoresBody.indexOf('syncStatsForScoreCandidateDates')).toBeGreaterThan(-1)
        expect(scoresBody.indexOf('syncScores')).toBeGreaterThan(scoresBody.indexOf('syncStatsForScoreCandidateDates'))
        expect(edgeScores).toContain('syncStatsForScoreCandidateDates')
        expect(edgeScores.indexOf('syncStatsForScoreCandidateDates()')).toBeGreaterThan(-1)
        expect(edgeScores.indexOf('syncScores()')).toBeGreaterThan(edgeScores.indexOf('syncStatsForScoreCandidateDates()'))
    })

    it('finalizes scoring weeks in cumulative standings order', () => {
        for (const rel of [
            'backend/src/sync/scores.ts',
            'supabase/functions/_shared/syncScores.ts',
        ]) {
            const src = read(rel)
            const finalizerStart = src.indexOf('async function finalizeWeekIfComplete')
            const finalizerEndCandidates = [
                src.indexOf('async function updateWeekPoints', finalizerStart + 1),
                src.indexOf('async function loadWeeksToSync', finalizerStart + 1),
                src.indexOf('export async function syncScores', finalizerStart + 1),
            ].filter((index) => index > finalizerStart)
            const finalizerBody = src.slice(
                finalizerStart,
                Math.min(...finalizerEndCandidates),
            )
            expect(src).toContain('loadWeeksToSync')
            expect(src).toContain('loadEarliestStatCorrectionWeek')
            expect(src).toContain('loadEarliestMissingFinalizedSnapshotWeek')
            expect(src).toContain('loadSeasonWeekBounds')
            expect(src).toContain('weekNumberForGameDate')
            expect(src).toContain('loadLeagueMemberIds')
            expect(src).toContain('syncStatsForCompletedWeeks')
            expect(src).toContain('syncStatsByDate(dateFromETDate(dateKey))')
            expect(src).toContain('const today = toETDate(referenceDate)')
            expect(src).toContain('if (game.game_date < today) return true')
            expect(src).toContain("return game.status !== 'Scheduled' && game.status !== 'InProgress'")
            expect(src).not.toContain('pendingWeeks')
            expect(src).toContain("from('player_game_stats')")
            expect(src).toContain("select('game_date, updated_at, nba_games!inner(nba_game_id)')")
            expect(src).toContain('FinalizedPlayoffMatchupTimestamp')
            expect(src).toContain('playoffFinalizationTimeByWeek')
            expect(src).toContain("select('week_number, finalized_at')")
            expect(src).toContain(".in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal', 'playoff_final'])")
            expect(src).toContain('const referenceTime = Math.min(...referenceTimes)')
            expect(src).toContain('updatedAt > referenceTime')
            expect(src).toContain("rpc('finalize_score_week_atomic'")
            expect(src).toContain('p_matchups: matchupResults.map')
            expect(src).toContain('p_standings: standingsRows.map')
            expect(src).toContain('p_reconciliation_at: reconciliationTimestamp')
            expect(src).toContain('await notifyFinalizedMatchups')
            expect(src).toContain('const missingSnapshotWeek = await loadEarliestMissingFinalizedSnapshotWeek')
            expect(src).toContain('return weekRange(earliestWeek, currentWeek)')
            expect(src).toContain("select('id, week_number')")
            expect(src).toContain('.lte(\'week_number\', currentWeek)')
            expect(src).toContain("eq('is_finalized', false)")
            expect(src).toContain("select('week_number, is_finalized')")
            expect(src).toContain("select('week_number, member_id')")
            expect(src).toContain('const weeksToSync = await loadWeeksToSync')
            expect(src).toContain('await syncStatsForCompletedWeeks')
            expect(src).toContain('const leagueMemberIds = await loadLeagueMemberIds(leagueId)')
            expect(src).toContain('const memberIds = leagueMemberIds.length > 0 ? leagueMemberIds : matchupMemberIds')
            expect(src).toContain('const standingsRows = await buildStandingsSnapshotRows')
            expect(src).toContain('if (standingsRows == null) return')
            expect(src).toContain('const snapshotCreatedAt = new Date().toISOString()')
            expect(src).toContain('created_at: snapshotCreatedAt')
            expect(src).toContain('return [...standingsByMember.values()]')
            expect(src).toContain('finalizedMatchupNotifications(notificationData)')
            expect(src).not.toContain('upsertStandingsSnapshots')
            expect(src).not.toContain(".upsert(upsertRows")
            expect(src).not.toContain('await insertStandingsSnapshots')
            expect(src).not.toContain("select('week_number, updated_at')")
            expect(src).not.toContain(".in('week_number', weeks)")
            expect(src).not.toContain(".not('week_number', 'is', null)")
            expect(finalizerBody).toContain('Finalized/reconciled week')
            expect(finalizerBody).not.toContain('alreadyFinalized')
            expect(finalizerBody).toContain('winner_member_id, is_finalized')
            expect(finalizerBody).not.toContain(".eq('is_finalized', false)")
            const standingsIndex = finalizerBody.indexOf('const standingsRows = await buildStandingsSnapshotRows')
            const rpcIndex = finalizerBody.indexOf("rpc('finalize_score_week_atomic'")
            const notifyIndex = finalizerBody.indexOf('await notifyFinalizedMatchups')
            expect(standingsIndex).toBeGreaterThan(-1)
            expect(rpcIndex).toBeGreaterThan(standingsIndex)
            expect(notifyIndex).toBeGreaterThan(rpcIndex)
            expect(src).toContain('latestPriorWeekByMember')
            expect(src).toContain('missing prior standings')
            expect(src).not.toContain('existingMembers')
            expect(src).not.toContain('Promise.all(finalizations)')
        }

        const finalizationMigration = read('supabase/migrations/20260627000027_atomic_score_finalization.sql')
        expect(finalizationMigration).toContain('CREATE OR REPLACE FUNCTION public.finalize_score_week_atomic')
        expect(finalizationMigration).toContain('FOR UPDATE')
        expect(finalizationMigration).toContain('UPDATE public.matchups AS matchup')
        expect(finalizationMigration).toContain('locked.is_finalized AS was_finalized')
        expect(finalizationMigration).toContain('WHERE was_finalized IS FALSE')
        expect(finalizationMigration).toContain('INSERT INTO public.standings')
        expect(finalizationMigration).toContain('ON CONFLICT (league_id, league_season_id, member_id, week_number)')
        expect(finalizationMigration).toContain('RETURN v_notifications')
        expect(finalizationMigration).toContain('GRANT EXECUTE ON FUNCTION public.finalize_score_week_atomic')
    })

    it('resolves playoff score ties before finalizing matchup winners', () => {
        for (const rel of [
            'backend/src/sync/scores.ts',
            'supabase/functions/_shared/syncScores.ts',
        ]) {
            const src = read(rel)
            const finalizerStart = src.indexOf('async function finalizeWeekIfComplete')
            const finalizerEndCandidates = [
                src.indexOf('async function updateWeekPoints', finalizerStart + 1),
                src.indexOf('async function loadWeeksToSync', finalizerStart + 1),
                src.indexOf('export async function syncScores', finalizerStart + 1),
            ].filter((index) => index > finalizerStart)
            const finalizerBody = src.slice(
                finalizerStart,
                Math.min(...finalizerEndCandidates),
            )

            expect(src).toContain('function isPlayoffMatchupType')
            expect(src).toContain("matchupType === 'playoff_quarterfinal'")
            expect(src).toContain("matchupType === 'playoff_semifinal'")
            expect(src).toContain("matchupType === 'playoff_final'")
            expect(src).toContain('resolveMatchupWinnerForScore')
            expect(src).toContain('if (!isPlayoffMatchupType(matchup.matchup_type)) return null')
            expect(src).toContain('if (homeMaxPossiblePoints > awayMaxPossiblePoints) return matchup.home_member_id')
            expect(src).toContain('if (awayMaxPossiblePoints > homeMaxPossiblePoints) return matchup.away_member_id')
            expect(src).toContain('return matchup.home_member_id')
            expect(finalizerBody).toContain('const homeMaxPossiblePoints = maxPossiblePointsByMember.get(m.home_member_id) ?? 0')
            expect(finalizerBody).toContain('const awayMaxPossiblePoints = maxPossiblePointsByMember.get(m.away_member_id) ?? 0')
            expect(finalizerBody).toContain('const winnerId = resolveMatchupWinnerForScore')
            expect(finalizerBody).not.toContain('homePoints === awayPoints\n                ? null')
            expect(finalizerBody).not.toContain('homePoints === awayPoints\n        ? null')
        }
    })

    it('derives schedule season year from game dates and caps post-season week lookup', () => {
        const edgeSchedule = read('supabase/functions/sync-schedule/index.ts')
        const backendSchedule = read('backend/src/sync/schedule.ts')
        const sharedSchedule = read('core/src/season/schedule.ts')
        const edgeSharedSchedule = read('supabase/functions/_shared/schedule.ts')
        expect(edgeSchedule).toContain("from '../_shared/schedule.ts'")
        expect(edgeSchedule).toContain('const plan = buildScheduleSyncPlan(raw)')
        expect(edgeSchedule).toContain('const result = await syncSchedule()')
        expect(edgeSchedule).toContain('return Response.json({ ok: true, ...result })')
        expect(edgeSchedule).toContain('Promise<{ updated: number; inserted: number; weeks: number }>')
        expect(edgeSchedule).toContain('return { updated: toUpdate.length, inserted: toInsert.length, weeks }')
        expect(edgeSchedule).toContain('async function syncSeasonWeeks(weeks: SeasonWeekRow[]): Promise<number>')
        expect(edgeSchedule).not.toContain('function seasonYearForGameDate')
        expect(edgeSchedule).not.toContain('function assertScheduleFresh')
        expect(edgeSchedule).not.toContain('month >= 7')
        expect(edgeSchedule).not.toContain('currentSeasonYear')
        expect(backendSchedule).toContain("from '@pancake/core'")
        expect(backendSchedule).toContain('const plan = buildScheduleSyncPlan(raw)')
        expect(backendSchedule).toContain('async function syncSeasonWeeks(weeks: SeasonWeekRow[]): Promise<number>')
        expect(backendSchedule).not.toContain('function seasonYearForGameDate')
        expect(backendSchedule).not.toContain('function assertScheduleFresh')
        expect(backendSchedule).not.toContain('month >= 7')
        expect(backendSchedule).toContain("from('season_weeks')")
        expect(backendSchedule).toContain("upsert(weeks, { onConflict: 'season_year,week_number' })")
        expect(backendSchedule).toContain("upsert(chunk as any, { onConflict: 'nba_game_id' })")
        expect(edgeSchedule).toContain(".upsert(toInsert.slice(i, i + CHUNK), { onConflict: 'nba_game_id' })")
        expect(edgeSchedule).toContain('if (error) throw error')
        for (const scheduleCore of [sharedSchedule, edgeSharedSchedule]) {
            expect(scheduleCore).toContain('seasonYearForGameDate')
            expect(scheduleCore).toContain('const seasonYear = seasonYearForGameDate(seasonStart)')
            expect(scheduleCore).toContain('assertScheduleFresh(regularSeason, seasonYear, now)')
            expect(scheduleCore).toContain('seasonEndYearFromScheduleLabel')
            expect(scheduleCore).toContain('NBA schedule payload is stale')
            expect(scheduleCore).toContain('latestGameDate && latestGameDate < today')
            expect(scheduleCore).toContain('started_at: normalizedScheduleTimestamp(game.startedAt)')
            expect(scheduleCore).toContain('game_time: normalizedScheduleTimestamp(game.startedAt)')
            expect(scheduleCore).not.toContain('currentSeasonYear')
        }
        expect(edgeSharedSchedule).toContain("from './gameId.ts'")

        const weekReader = read('lib/shared/week.ts')
        expect(weekReader).toContain('lastWeek')
        expect(weekReader).toContain('today > lastWeek.week_end')
        expect(weekReader).toContain('return lastWeek.week_number')
        expect(weekReader).toContain('if (todayErr) throw todayErr')
        expect(weekReader).toContain('if (futureErr) throw futureErr')
        expect(weekReader).toContain('if (lastErr) throw lastErr')
    })
})
