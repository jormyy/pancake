#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { endOfETDayUTC } from '@pancake/core'
import { ensureSyntheticSeasonWeeks } from '../../tests/e2e/soak-fixtures.mjs'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2])
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
requireLocal(env.E2E_SUPABASE_URL)
requireLocal(env.SUPABASE_DB_URL, 'postgresql:')
const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const checked = async operation => { const { data, error } = await operation; if (error) throw new Error(error.message); return data }
const members = await checked(admin.from('league_members').select('id,user_id,team_name').eq('league_id', state.leagueId))
const me = members.find(row => row.user_id === state.users[0].id)
const other = members.find(row => row.user_id === state.users[1].id)
const season = await checked(admin.from('league_seasons').select('*').eq('league_id', state.leagueId).eq('is_current', true).single())
const draft = await checked(admin.from('drafts').select('id').eq('league_id', state.leagueId).eq('draft_type', 'auction').single())
await ensureSyntheticSeasonWeeks(admin, season.season_year, 26, 'verification')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const weeks = await checked(admin.from('season_weeks').select('*').eq('season_year', season.season_year).order('week_number'))
const week = weeks.find(row => row.week_start <= today && row.week_end >= today)
assert.ok(week, 'Fixture requires a current season week')
await checked(admin.from('league_seasons').update({ regular_season_start: weeks[0].week_start, regular_season_end: weeks[18].week_end, playoff_start_week: 20 }).eq('id', season.id))
await checked(admin.from('drafts').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('league_id', state.leagueId).eq('draft_type', 'auction'))
await checked(admin.from('leagues').update({ status: 'active', taxi_slots: 2 }).eq('id', state.leagueId))
const players = await checked(admin.from('players').select('id,display_name,position,nba_team').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id'))
const scope = { league_id: state.leagueId, league_season_id: season.id }
for (const [index, member] of [me, other].entries()) {
  const active = players.slice(index * 20, index * 20 + 14)
  const ir = players[index * 20 + 14]
  const taxi = players[index * 20 + 15]
  await checked(admin.from('players').update({ injury_status: 'Out' }).eq('id', ir.id))
  await checked(admin.from('players').update({ years_exp: 0, career_regular_season_games: 0 }).eq('id', taxi.id))
  await checked(admin.from('roster_players').insert([
    ...active.map(player => ({ ...scope, member_id: member.id, player_id: player.id, acquired_via: 'verification', is_on_ir: false, is_on_taxi: false, taxi_start_season_year: null })),
    { ...scope, member_id: member.id, player_id: ir.id, acquired_via: 'verification', is_on_ir: true, is_on_taxi: false, taxi_start_season_year: null },
  ]))
  const ids = [state.leagueId, season.id, member.id, taxi.id, draft.id]
  for (const id of ids) assert.match(id, /^[a-f0-9-]{36}$/)
  const [leagueId, seasonId, memberId, playerId, draftId] = ids
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-c', `BEGIN;
    SELECT private.authorize_taxi_acquisition('${leagueId}', '${seasonId}', '${memberId}', '${playerId}', 'draft', '${draftId}');
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
    VALUES('${leagueId}','${seasonId}','${memberId}','${playerId}','draft',true);
    COMMIT;`], { stdio: ['ignore', 'ignore', 'pipe'] })
  await checked(admin.from('weekly_lineups').insert(['PG', 'SG', 'SF', 'PF', 'C'].map(position => ({ ...scope, member_id: member.id, player_id: active.find(player => player.position === position).id, week_number: week.week_number, game_date: today, slot_type: position }))))
}
await checked(admin.from('matchups').delete().eq('league_id', state.leagueId))
await checked(admin.from('matchups').insert({ ...scope, week_number: week.week_number, home_member_id: me.id, away_member_id: other.id, home_points: 123, away_points: 117 }))
const gameDays = [today, new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)]
await checked(admin.from('nba_games').insert(gameDays.flatMap((game_date, index) => ['ATL', 'CHI', 'DEN', 'LAL'].map((home_team, i) => ({ season_year: season.season_year, week_number: week.week_number, game_date, home_team, away_team: ['BOS', 'DAL', 'GSW', 'MIA'][i], status: 'Scheduled', game_time: new Date(Date.parse(endOfETDayUTC(game_date)) - 1).toISOString(), nba_game_id: `verify-${index}-${i}` })))))
await checked(admin.rpc('propose_trade_atomic', { p_league_id: state.leagueId, p_league_season_id: season.id, p_proposer_member_id: me.id, p_recipient_member_id: other.id, p_offer_player_ids: [players[0].id], p_request_player_ids: [players[20].id], p_offer_pick_ids: [], p_request_pick_ids: [] }))
await checked(admin.from('waiver_claims').insert({ ...scope, member_id: me.id, player_id: players[50].id, priority_at_submission: 1, process_date: gameDays[1], bid_amount: 3, status: 'pending' }))
const pastSeasonId = randomUUID()
const pastSeasonYear = season.season_year - 1
await ensureSyntheticSeasonWeeks(admin, pastSeasonYear, 26, 'verification-history')
await checked(admin.from('league_seasons').insert({ id: pastSeasonId, league_id: state.leagueId, season_year: pastSeasonYear, is_current: false, playoff_start_week: 3, playoff_round_weeks: [1], playoff_bracket_seed_ids: [me.id, other.id] }))
await checked(admin.from('matchups').insert([
  { league_id: state.leagueId, league_season_id: pastSeasonId, week_number: 1, matchup_type: 'regular_season', home_member_id: me.id, away_member_id: other.id, home_points: 120, away_points: 100, winner_member_id: me.id, is_finalized: true, finalized_at: new Date().toISOString() },
  { league_id: state.leagueId, league_season_id: pastSeasonId, week_number: 2, matchup_type: 'regular_season', home_member_id: me.id, away_member_id: other.id, home_points: 90, away_points: 110, winner_member_id: other.id, is_finalized: true, finalized_at: new Date().toISOString() },
  { league_id: state.leagueId, league_season_id: pastSeasonId, week_number: 3, end_week_number: 3, matchup_type: 'playoff_final', playoff_round: 1, playoff_position: 1, home_member_id: me.id, away_member_id: other.id, home_points: 100, away_points: 130, winner_member_id: other.id, is_finalized: true, finalized_at: new Date().toISOString() },
]))
execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT private.rebuild_regular_standings('${state.leagueId}', '${pastSeasonId}');`], { stdio: ['ignore', 'ignore', 'pipe'] })
const history = JSON.parse(execFileSync('psql', [env.SUPABASE_DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: `BEGIN; SET LOCAL "request.jwt.claim.sub" = '${me.user_id}'; SELECT public.view_league_history('${state.leagueId}', '${me.id}'); ROLLBACK;`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }))
assert.equal(history.seasons.length, 1)
assert.equal(history.seasons[0].id, pastSeasonId)
assert.equal(history.seasons[0].champion.memberId, other.id)
assert.deepEqual(history.seasons[0].stats, { teams: members.length, games: 2, pointsFor: 420 })
const fixture = { leagueId: state.leagueId, seasonId: season.id, memberId: me.id, otherMemberId: other.id, currentWeek: week.week_number, today, benchPlayerId: players[7].id, benchPlayerName: players[7].display_name, freePlayerId: players[51].id, completedPastSeason: true, pastSeasonId, pastSeasonYear, history: history.seasons[0], counts: { members: members.length, activePerTeam: 14, irPerTeam: 1, taxiPerTeam: 1, pendingTrades: 1, pendingWaivers: 1 } }
await writeFile(path.join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n')
console.log('Seeded active league, current matchup, starters, bench, IR, taxi, waivers, pending trade, and completed season history.')
