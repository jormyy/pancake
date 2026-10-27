import assert from 'node:assert/strict'
import { createFixtureResourceOwner, findAvailablePlayers, setupTradeGameplayFixture } from './trade-fixture.mjs'
import { seasonWeekRows } from './harness/season-calendar.mjs'

const db = async operation => { const result = await operation; if (result.error) throw new Error(result.error.message); return result.data }
const addDays = (value, days) => new Date(Date.parse(`${value}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

export async function setupScoredPlayoffFixture(env, season) {
  assert.ok(process.env.PANCAKE_EDGE_INTERNAL_TOKEN, 'Local internal worker token is required')
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 10, isolatedPlayers: true, includeFuturePicks: false })
  const { admin, league, currentSeason } = fixture
  const resources = createFixtureResourceOwner(admin)
  const members = await db(admin.from('league_members').select('id,user_id,team_name').eq('league_id', league.id).order('joined_at').order('id'))
  const usedYears = new Set((await db(admin.from('season_weeks').select('season_year'))).map(row => row.season_year))
  const year = Array.from({ length: 30 }, (_, index) => 2001 + index).find(value => value < new Date().getFullYear() && !usedYears.has(value))
  assert.ok(year, 'An unused historical fixture year is required')
  const weeks = seasonWeekRows(year, 26)
  const first = weeks[0].week_start
  await db(admin.from('season_weeks').insert(weeks))
  const gameIds = []
  resources.registerCleanup('scored playoff fixture calendar', async () => {
    if (gameIds.length) {
      await db(admin.from('player_game_stats').delete().in('game_id', gameIds))
      await db(admin.from('nba_games').delete().in('id', gameIds))
    }
    await db(admin.from('season_weeks').delete().eq('season_year', year))
  })
  await db(admin.from('leagues').update({ status: 'playoffs', playoff_entrants: 4, playoff_start_week: 18, playoff_round_lengths: [2, 2], playoff_round_weeks: [2, 2], playoff_total_weeks: 4,
    scoring_settings: { points: 1, rebounds: 1, assists: 2, steals: 4, blocks: 4, turnovers: -2, field_goals_made: 2, field_goals_attempted: -1, free_throws_made: 1, free_throws_attempted: -1, three_pointers_made: 1 } }).eq('id', league.id))
  await db(admin.from('league_seasons').update({ season_year: year, playoff_start_week: 18, playoff_round_weeks: [2, 2], skipped_weeks: [1] }).eq('id', currentSeason.id))
  currentSeason.season_year = year
  const players = await findAvailablePlayers(admin, league.id, currentSeason.id, members.length, fixture.registerCreatedPlayer, { createOnly: true })
  await db(admin.from('players').update({ nba_team: 'BOS', position: 'PG', eligible_positions: ['PG'] }).in('id', players.map(player => player.id)))
  await db(admin.from('roster_players').delete().eq('league_id', league.id))
  await db(admin.from('roster_players').insert(members.map((member, index) => ({ league_id: league.id, league_season_id: currentSeason.id, member_id: member.id,
    player_id: players[index].id, acquired_via: 'draft', acquired_at: `${first}T00:00:00Z` }))))
  const regular = weeks.slice(1, 17).flatMap(week => Array.from({ length: members.length / 2 }, (_, index) => ({ league_id: league.id,
    league_season_id: currentSeason.id, week_number: week.week_number, matchup_type: 'regular_season', home_member_id: members[index].id, away_member_id: members[members.length - 1 - index].id })))
  await db(admin.from('matchups').insert(regular))
  const points = new Map(members.map((member, index) => [member.id, 100 - index * 5]))
  let lastSeededWeek = 1
  const scoreThrough = async through => {
    assert.ok([17, 19, 21].includes(through), 'Score only complete regular-season or playoff rounds')
    const selected = weeks.filter(week => week.week_number > lastSeededWeek && week.week_number <= through)
    for (const week of selected) {
      const game = await db(admin.from('nba_games').insert({ nba_game_id: `002${String(year - 1).slice(-2)}${String(week.week_number).padStart(5, '0')}`, season_year: year,
        game_date: week.week_start, week_number: week.week_number, home_team: 'BOS', away_team: 'NYK', status: 'Final', stats_synced_at: new Date().toISOString() }).select('id').single())
      gameIds.push(game.id)
      await db(admin.from('player_game_stats').insert(members.map((member, index) => ({ game_id: game.id, player_id: players[index].id,
        game_date: week.week_start, season_year: year, week_number: week.week_number, points: points.get(member.id), minutes_played: 30,
        rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, did_not_play: false }))))
      await db(admin.from('weekly_lineups').insert(members.map((member, index) => ({ league_id: league.id, league_season_id: currentSeason.id, member_id: member.id,
        player_id: players[index].id, week_number: week.week_number, game_date: week.week_start, slot_type: 'PG' }))))
    }
    lastSeededWeek = through
    const response = await fetch(`${env.supabaseUrl}/functions/v1/sync-scores`, { method: 'POST',
      headers: { apikey: env.anonKey, authorization: `Bearer ${env.serviceRoleKey}`, 'content-type': 'application/json', 'x-internal-function-token': process.env.PANCAKE_EDGE_INTERNAL_TOKEN },
      body: JSON.stringify({ leagueId: league.id, date: `${addDays(weeks[through - 1].week_end, 1)}T12:00:00Z` }) })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    const rows = await db(admin.from('matchups').select('id,week_number,end_week_number,home_member_id,away_member_id,home_points,away_points,winner_member_id,is_finalized')
      .eq('league_season_id', currentSeason.id).lte('week_number', through))
    const verify = observed => {
      assert.equal(observed.length, regular.length + (through >= 19 ? 2 : 0) + (through >= 21 ? 1 : 0))
      for (const row of observed) {
        const span = (row.end_week_number ?? row.week_number) - row.week_number + 1
        assert.equal(row.home_points, points.get(row.home_member_id) * span)
        assert.equal(row.away_points, points.get(row.away_member_id) * span)
        assert.equal(row.is_finalized, true)
        assert.equal(row.winner_member_id, points.get(row.home_member_id) > points.get(row.away_member_id) ? row.home_member_id : row.away_member_id)
      }
    }
    verify(rows)
    for (const fault of [{ home_points: rows[0].home_points + 1 }, { is_finalized: false }, { winner_member_id: 'wrong-team' }]) {
      assert.throws(() => verify([{ ...rows[0], ...fault }, ...rows.slice(1)]))
    }
    assert.throws(() => verify(rows.slice(1)))
    return { through, checkedMatchups: rows.length, workerStatus: response.status, rejectedFaults: ['wrong score', 'unfinalized result', 'wrong winner', 'missing matchup'] }
  }
  return { ...fixture, members, scoreThrough, regularMatchups: regular.length }
}
