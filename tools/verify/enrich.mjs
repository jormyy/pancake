import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2])
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
assert.ok(!run.cleanedAt)
requireLocal(env.E2E_SUPABASE_URL)
requireLocal(env.SUPABASE_DB_URL, 'postgresql:')
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const checked = async operation => { const { data, error } = await operation; if (error) throw new Error(error.message); return data }
const members = await checked(admin.from('league_members').select('id').eq('league_id', fixture.leagueId))
const third = members.find(member => member.id !== fixture.memberId && member.id !== fixture.otherMemberId)
const fourth = members.find(member => ![fixture.memberId, fixture.otherMemberId, third.id].includes(member.id))
const seeds = [fixture.memberId, fixture.otherMemberId, third.id, fourth.id]
const otherTeams = members.filter(member => ![fixture.memberId, fixture.otherMemberId].includes(member.id))
const regularGames = await checked(admin.from('matchups').select('home_member_id,away_member_id').eq('league_season_id', fixture.seasonId).eq('week_number', fixture.currentWeek).eq('matchup_type', 'regular_season'))
for (let index = 0; index < otherTeams.length; index += 2) {
  const home = otherTeams[index].id
  const away = otherTeams[index + 1].id
  if (!regularGames.some(game => game.home_member_id === home && game.away_member_id === away)) {
    await checked(admin.from('matchups').insert({ league_id: fixture.leagueId, league_season_id: fixture.seasonId,
      week_number: fixture.currentWeek, matchup_type: 'regular_season', home_member_id: home, away_member_id: away }))
  }
}
await checked(admin.from('league_seasons').update({ playoff_bracket_seed_ids: seeds, playoff_round_weeks: [2, 2] }).eq('id', fixture.seasonId))
const bracket = await checked(admin.from('matchups').select('id').eq('league_season_id', fixture.seasonId).eq('matchup_type', 'playoff_semifinal'))
if (!bracket.length) await checked(admin.from('matchups').insert([[seeds[0], seeds[3]], [seeds[1], seeds[2]]].map(([home, away], index) => ({
  league_id: fixture.leagueId, league_season_id: fixture.seasonId, week_number: 20, end_week_number: 21,
  matchup_type: 'playoff_semifinal', playoff_round: 1, playoff_position: index + 1, home_member_id: home, away_member_id: away,
}))))
const players = await checked(admin.from('players').select('id,display_name').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id'))
const roster = await checked(admin.from('roster_players').select('player_id').eq('league_id', fixture.leagueId))
const additions = players.slice(40, 46).filter(player => !roster.some(row => row.player_id === player.id))
if (additions.length) await checked(admin.from('roster_players').insert(additions.map(player => ({ league_id: fixture.leagueId, league_season_id: fixture.seasonId, member_id: third.id, player_id: player.id, acquired_via: 'verification' }))))
const years = [fixture.pastSeasonYear, fixture.pastSeasonYear + 1]
const games = []
for (const [index, year] of years.entries()) {
  const date = `${year - 1}-11-03`
  const week = await checked(admin.from('season_weeks').select('week_number').eq('season_year', year).lte('week_start', date).gte('week_end', date).single())
  const game = await checked(admin.from('nba_games').upsert({ nba_game_id: `002${String(year - 1).slice(-2)}98901`, season_year: year, week_number: week.week_number, game_date: date, home_team: 'ATL', away_team: 'DAL', status: 'Final', home_score: 112, away_score: 108 }, { onConflict: 'nba_game_id' }).select('id').single())
  const stats = [players[0], players[51]].map(player => ({ player_id: player.id, game_id: game.id, game_date: date, season_year: year, week_number: week.week_number, points: 20 + index * 4, rebounds: 6, assists: 4, steals: 1, blocks: 1, turnovers: 2, minutes_played: 30, field_goals_made: 8, field_goals_attempted: 16, free_throws_made: 2, free_throws_attempted: 2, three_pointers_made: 2, did_not_play: false }))
  const saved = await checked(admin.from('player_game_stats').upsert(stats, { onConflict: 'player_id,game_id' }).select('id,player_id'))
  games.push({ id: game.id, statId: saved.find(row => row.player_id === players[0].id).id, year, date, points: stats[0].points })
}
await checked(admin.from('dynasty_news').delete().eq('source', 'verification'))
await checked(admin.from('dynasty_news').insert([players[0], players[51]].map(player => ({ player_id: player.id, source: 'verification', title: `${player.display_name} ready for the next game`, summary: 'The player completes practice and prepares for the next game.', url: `${run.url}/verification-news.html?player=${player.id}`, published_at: new Date().toISOString() }))))
const history = await checked(admin.from('roster_transactions').select('id').eq('league_id', fixture.leagueId).eq('player_id', players[0].id).limit(1))
if (!history.length) await checked(admin.from('roster_transactions').insert({ league_id: fixture.leagueId, league_season_id: fixture.seasonId, member_id: fixture.memberId, player_id: players[0].id, transaction_type: 'fa_add' }))
await writeFile(path.join(run.work, 'dist/verification-news.html'), '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verification player news</title><h1>Player practice report</h1><p>The player completes practice and prepares for the next game.</p></html>')
execFileSync('psql', [env.SUPABASE_DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT private.refresh_player_averages('${fixture.leagueId}', '${fixture.seasonId}', (SELECT version FROM private.screen_refresh_queue WHERE league_season_id = '${fixture.seasonId}'));`], { stdio: ['ignore', 'ignore', 'pipe'] })
const season = await checked(admin.from('league_seasons').select('season_year').eq('id', fixture.seasonId).single())
const rookieDraft = await checked(admin.from('drafts').select('id').eq('league_season_id', fixture.seasonId).eq('draft_type', 'snake').eq('is_mock', false).maybeSingle())
if (rookieDraft) {
  const slots = await checked(admin.from('snake_draft_picks').select('id,member_id,round,draft_pick_id').eq('draft_id', rookieDraft.id))
  for (const slot of slots.filter(row => !row.draft_pick_id)) {
    let pick = await checked(admin.from('draft_picks').select('id').eq('league_id', fixture.leagueId).eq('season_year', season.season_year).eq('round', slot.round).eq('original_owner_id', slot.member_id).maybeSingle())
    if (!pick) pick = await checked(admin.from('draft_picks').insert({ league_id: fixture.leagueId, season_year: season.season_year, round: slot.round, original_owner_id: slot.member_id, current_owner_id: slot.member_id }).select('id').single())
    await checked(admin.from('snake_draft_picks').update({ draft_pick_id: pick.id }).eq('id', slot.id))
  }
  if (slots.every(slot => !slot.draft_pick_id)) {
    await checked(admin.from('drafts').update({ pick_timer_seconds: 3600 }).eq('id', rookieDraft.id))
    await checked(admin.from('snake_draft_picks').update({ timer_expires_at: new Date(Date.now() + 3600000).toISOString() }).eq('draft_id', rookieDraft.id).is('player_id', null).is('skipped_at', null))
  }
  fixture.rookieDraftId = rookieDraft.id
  fixture.rookies = []
  for (const number of [1, 2]) {
    const rookie = await checked(admin.from('players').upsert({ sportsdata_id: `verify-rookie-${number}`, first_name: 'Sweep', last_name: `Rookie ${number}`, position: 'PG', eligible_positions: ['PG'], nba_team: 'BOS', years_exp: 0, nba_draft_number: number, career_regular_season_games: 0 }, { onConflict: 'sportsdata_id' }).select('id,display_name').single())
    fixture.rookies.push(rookie)
  }
}
fixture.thirdMemberId = third.id
fixture.playerGames = games
fixture.newsUrl = `${run.url}/verification-news.html`
fixture.bracketSeedMemberIds = seeds
await writeFile(path.join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n')
console.log('Seeded a third roster, two statistics seasons, and local player news.')
