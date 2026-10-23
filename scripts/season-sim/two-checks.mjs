import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureDirectory, writeJson, miniRoot } from './common.mjs'
import { checkCalendar } from './calendar-oracle.mjs'
import { checkPostponement } from './postponement-oracle.mjs'
import { checkIdentityGame, checkContinuity } from './identity-oracle.mjs'
import { sqlJson } from './local-stack.mjs'
import { shiftDay } from './season-model.mjs'

export function areaCheck(area, check) {
  try { return check() } catch (error) { error.area = area; throw error }
}

export function draftSourceUnavailable(functionName,at,availableAt,error){
  return functionName==='sync-draft-order'&&at<Date.parse(availableAt)&&/Could not load a complete/.test(error)&&/503/.test(error)
}

export async function twoPlan() {
  if (process.env.SEASON_SIM_MODE !== 'two-season') return null
  const plan = JSON.parse(await readFile(path.join(fixtureDirectory, 'two-season-plan.json'), 'utf8'))
  assert.equal(plan.mode, 'two-real-seasons')
  assert.deepEqual(plan.seasons.map(row => row.year), [2025, 2026])
  return plan
}

export async function assertTwoCalendar(c, profile, openingOnly=false) {
  const rows = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=${profile.year}`, 'Raw-schedule calendar comparison')
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  const expected=openingOnly?{...profile.calendar,weeks:profile.calendar.weeks.slice(0,1)}:profile.calendar
  const result = areaCheck('opening-night / all-star-week', () => checkCalendar(expected, openingOnly?rows.slice(0,1):rows, matchups, c.users.map(user => user.memberId), c.skippedWeeks ?? []))
  const excluded = await sqlJson(`SELECT coalesce(json_agg(nba_game_id),'[]') FROM nba_games WHERE season_year=${profile.year} AND nba_game_id NOT LIKE '${profile.prefix}%'`, 'NBA Cup and exhibition exclusion')
  assert.deepEqual(excluded, [], 'No NBA Cup final or exhibition enters regular-season storage')
  return { ...result,scope:openingOnly?'Opening-week subset; full-calendar failure remains fatal':'Complete calendar', cupFinalsExcluded: profile.cupFinals, countedCupGames: profile.countedCupGames }
}

export async function assertPublishedCalendar(profile){
  const rows=await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=${profile.year}`,'Published fantasy calendar')
  const observed=rows.map(({week_number,week_start,week_end})=>({week_number,week_start,week_end}))
  const area=JSON.stringify(observed[0])===JSON.stringify(profile.calendar.weeks[0])?'all-star-week':'opening-night'
  return areaCheck(area,()=>assert.deepEqual(observed,profile.calendar.weeks,'Calendar starts on the first 002 game day and merges the observed All-Star gap'))
}

export async function assertTwoDay(c, date, report, plan, store, today) {
  const profile = plan.seasons.find(row => row.year === c.seasonYear)
  const timelines = plan.postponements.timelines.filter(row => row.originalDate <= date && row.originalDate >= profile.start && row.originalDate <= profile.end)
  const storedGames = await sqlJson(`SELECT coalesce(json_agg(g),'[]') FROM nba_games g WHERE season_year=${c.seasonYear}`, 'Observed schedule identities')
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  const results = []
  for (const timeline of timelines) {
    const week = profile.calendar.weeks.find(row => timeline.originalDate >= row.week_start && timeline.originalDate <= row.week_end).week_number
    const stats = await sqlJson(`SELECT coalesce(json_agg(s),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.nba_game_id='${timeline.id}'`, 'Makeup game stats')
    results.push(areaCheck('postponement', () => checkPostponement({ timeline, calendar: profile.calendar, originalMatchups: matchups.filter(row => row.week_number === week && !row.is_voided), storedGames, stats, date, closedThrough: shiftDay(date,1) })))
  }
  const rookies = c.seasonYear === plan.seasons[1].year ? plan.draft.rookies : []
  const subjects = (c.nbaTradeSubjects ?? []).filter(row => row.year === c.seasonYear)
  const expected = []
  for (const game of today) {
    const box = await store.json(`boxscore-${game.id}`)
    for (const player of [...box.game.homeTeam.players, ...box.game.awayTeam.players]) {
      const rookie = rookies.find(row => row.nbaId === String(player.personId))
      if (!rookie && !subjects.some(subject => subject.nbaId === String(player.personId))) continue
      const drafted = c.draftedRookies?.find(row => row.nbaId === String(player.personId))
      const preference = c.rookiePreferences?.find(row => row.date === date && row.nbaId === String(player.personId))
      expected.push({ nbaId: String(player.personId), name: rookie?.name ?? player.name, gameId: game.id, date, raw: player, draftPlayerId: drafted?.playerId, ...preference })
    }
  }
  const identities = []
  if (expected.length) {
    const input = await sqlJson(`SELECT json_build_object('players',(SELECT json_agg(p) FROM players p),'stats',(SELECT json_agg(q) FROM (SELECT s.*,g.nba_game_id FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.game_date='${date}') q),'fantasy',(SELECT json_agg(q) FROM (SELECT v.*,g.nba_game_id FROM v_fantasy_points v JOIN nba_games g ON g.id=v.game_id WHERE v.league_id='${c.leagueId}' AND g.game_date='${date}') q),'lineups',(SELECT coalesce(json_agg(l),'[]') FROM weekly_lineups l WHERE league_season_id='${c.leagueSeasonId}' AND game_date='${date}'),'settings',(SELECT scoring_settings FROM leagues WHERE id='${c.leagueId}'))`, 'Independent real-player continuity inputs')
    assert.ok(input.stats && input.fantasy, 'Expected real rookie/traded-player rows must exist')
    for (const row of expected) identities.push(areaCheck('rookie-identity', () => checkIdentityGame({ expected: row, ...input })))
  }
  for (const subject of subjects.filter(row => !row.verified)) {
    const game = today.find(game => [game.home,game.away].includes(subject.to))
    const appeared = identities.some(row => row.nbaId === subject.nbaId && row.points !== 0 && row.started===true)
    if (game && appeared && date >= subject.firstAfter) {
      const roster = await c.rest(c.users[0], `roster_players?select=*&league_season_id=eq.${c.leagueSeasonId}`)
      const players = await c.rest(c.users[0], `players?select=id,nba_id,nba_team&nba_id=eq.${subject.nbaId}`)
      subject.afterGameCount = (subject.afterGameCount ?? 0) + 1
      report.nbaTrades ??= []
      report.nbaTrades.push(areaCheck('nba-trades', () => checkContinuity(subject, players, roster, subject.afterGameCount)))
      subject.verified = true
    }
  }
  const result = { date, year: c.seasonYear, provenance: 'REAL-RAW boxes; REAL-DERIVED calendar; SYNTHETIC manager preferences', postponements: results, identities }
  report.realInputChecks ??= []
  report.realInputChecks.push(result)
  await writeJson(path.join(miniRoot, `evidence/real-input-${date}.json`), result)
  return result
}
