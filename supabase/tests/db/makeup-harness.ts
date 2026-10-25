import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const [endpoint, port, protocols] of [
  [api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321', ['http:', 'https:']],
  [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322', ['postgres:', 'postgresql:']],
] as const) {
  const url = new URL(endpoint)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port && protocols.some(protocol => protocol === url.protocol), `Only loopback port ${port} is allowed`)
}
export const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
export const sql = async (statement: string) => {
  const output = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}
export const day = (date: string, count: number) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
type ProviderGame = { game: string; provider: string; mode: string; points: number[]; ids: number[]; confirm?: string; calls: number }
export const finalizedWeeks: { season: string; week: number }[] = []
const providerGames = new Map<string, ProviderGame>()
const nativeFetch = globalThis.fetch.bind(globalThis)
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const key = new URL(request.url).pathname.match(/boxscore_(.+)[.]json$/)?.[1]
  const entry = key ? providerGames.get(key) : null
  assert.ok(entry, `Unexpected provider path ${request.url}`)
  entry.calls++
  if (entry.confirm) {
    const marker = entry.confirm
    entry.confirm = undefined
    await q(supabase.from('nba_games').update({ status: 'Scheduled', game_status_text: marker }).eq('id', entry.game))
  }
  if (['403', '404', '500'].includes(entry.mode)) return new Response('Synthetic provider outage', { status: Number(entry.mode) })
  if (entry.mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 200))
  const status = entry.mode === 'scheduled' ? 1 : entry.mode === 'live' ? 2 : 3
  const players = entry.ids.map((personId, index) => ({ personId, name: `Synthetic Makeup ${personId}`, played: '1', statistics: {
    minutes: 'PT20M00.00S', points: entry.points[index], reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
    assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0,
    threePointersMade: 0, threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0,
  } }))
  return Response.json({ game: { gameId: entry.provider, gameStatus: status, period: 4, gameClock: 'PT01M00.00S',
    homeTeam: { players: status === 1 ? [] : players.slice(0, 2) }, awayTeam: { players: status === 1 ? [] : players.slice(2) } } })
})
const origin = `http://127.0.0.1:${provider.addr.port}`
Deno.env.set('NBA_CDN_BASE_URL', origin)
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok([api, origin].includes(url.origin), 'Only fixture services receive requests')
  const key = url.pathname.match(/boxscore_(.+)[.]json$/)?.[1]
  if (url.origin === origin && key && providerGames.get(key)?.mode === 'timeout') {
    return nativeFetch(input, { ...init, signal: AbortSignal.timeout(30) })
  }
  const publication = url.pathname.endsWith('/rpc/finalize_score_week_atomic') ? await new Request(input, init).json() : null
  const response = await nativeFetch(input, init)
  if (publication && response.ok) finalizedWeeks.push({ season: publication.p_league_season_id, week: publication.p_week_number })
  return response
}
export const { supabase } = await import('../../functions/_shared/supabase.ts')
export const { syncScores } = await import('../../functions/_shared/syncScores.ts')
export const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
export const closeProvider = async () => { globalThis.fetch = nativeFetch; await provider.shutdown() }

export async function fixture(season = 2025, merged = false, homeTeam = 'BOS', awayTeam = 'MIA') {
  const league = crypto.randomUUID(), seasonId = crypto.randomUUID()
  const members = [crypto.randomUUID(), crypto.randomUUID()]
  const players = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const users: string[] = [], games: string[] = []
  const password = `Synthetic-${crypto.randomUUID()}!`
  const ids = players.map(() => 1000000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000000)
  const first = season === 2024 ? '2024-10-21' : '2025-10-20'
  let year = 0
  for (let candidate = 9801; candidate < 9901; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate))).length) { year = candidate; break }
  }
  assert.ok(year)
  for (const member of members) {
    const result = await supabase.auth.admin.createUser({ email: `makeup-${member}@example.test`, password, email_confirm: true,
      user_metadata: { username: `makeup_${member.replaceAll('-', '').slice(0, 16)}` } })
    if (result.error) throw result.error
    users.push(result.data.user!.id)
  }
  await q(supabase.from('leagues').insert({ id: league, name: 'Synthetic range scoring', slug: league, commissioner_id: users[0],
    status: 'active', team_limit: 2, scoring_settings: { points: 1 }, playoff_start_week: merged ? 23 : 14, playoff_entrants: 2, playoff_round_lengths: [2] }))
  await q(supabase.from('league_members').insert(members.map((id, index) => ({ id, league_id: league, user_id: users[index], role: index ? 'manager' as const : 'commissioner' as const, team_name: `Side ${index}` }))))
  await q(supabase.from('league_seasons').insert({ id: seasonId, league_id: league, season_year: year, is_current: true }))
  const weeks = Array.from({ length: 25 }, (_, index) => ({ season_year: year, week_number: index + 1,
    week_start: index === 0 ? day(first, 1) : day(first, index * 7), week_end: day(first, index * 7 + 6) }))
  if (merged) {
    weeks[16].week_end = weeks[17].week_end
    weeks.splice(17, 1)
    weeks.forEach((week, index) => { week.week_number = index + 1 })
  }
  await q(supabase.from('season_weeks').insert(weeks))
  await q(supabase.from('players').insert(players.map((id, index) => ({ id, first_name: 'Synthetic', last_name: `Makeup ${ids[index]}`,
    nba_id: String(ids[index]), position: 'PG' as const, eligible_positions: ['PG' as const], nba_team: index === 2 ? awayTeam : homeTeam }))))
  await q(supabase.from('lineup_slot_templates').delete().eq('league_id', league))
  await q(supabase.from('lineup_slot_templates').insert({ league_id: league, slot_type: 'UTIL', slot_count: 1 }))
  await q(supabase.from('roster_players').insert(players.map((player_id, index) => ({ player_id, league_id: league, league_season_id: seasonId,
    member_id: members[index === 2 ? 1 : 0], acquired_via: 'draft', acquired_at: `${day(first, -7)}T12:00:00Z` }))))
  const weekFor = (date: string) => weeks.find(week => week.week_start <= date && date <= week.week_end)!.week_number
  const matchup = async (week: number, type: 'regular_season' | 'playoff_final' = 'regular_season', end?: number) => {
    const id = crypto.randomUUID()
    await q(supabase.from('matchups').insert({ id, league_id: league, league_season_id: seasonId, week_number: week,
      home_member_id: members[0], away_member_id: members[1], matchup_type: type, end_week_number: end ?? null }))
    return id
  }
  const game = async (date: string, status: string, text = '', points?: number[]) => {
    const id = crypto.randomUUID(), providerId = `002-makeup-${id}`
    games.push(id)
    await q(supabase.from('nba_games').insert({ id, nba_game_id: providerId, season_year: year, week_number: weekFor(date),
      game_date: date, game_time: `${date}T23:00:00Z`, home_team: homeTeam, away_team: awayTeam, status, game_status_text: text,
      stats_synced_at: status === 'Final' && points ? new Date().toISOString() : null }))
    const entry = { game: id, provider: providerId, mode: status === 'InProgress' ? 'live' : status === 'Scheduled' ? 'scheduled' : 'final',
      points: points ?? [20, 30, 5], ids, calls: 0 } as ProviderGame
    providerGames.set(providerId, entry)
    if (points) await q(supabase.from('player_game_stats').insert(players.map((player_id, index) => ({ player_id, game_id: id,
      season_year: year, week_number: weekFor(date), game_date: date, points: points[index], did_not_play: false }))))
    return entry
  }
  const lineup = async (date: string) => q(supabase.from('weekly_lineups').insert(players.map((player_id, index) => ({ player_id,
    league_id: league, league_season_id: seasonId, member_id: members[index === 2 ? 1 : 0], week_number: weekFor(date), game_date: date,
    slot_type: index === 1 ? 'BE' as const : 'UTIL' as const, is_auto_set: false }))))
  const read = () => q(supabase.from('matchups').select('*').eq('league_season_id', seasonId).order('week_number'))
  const capture = (week: number) => q(supabase.rpc('capture_score_inputs', { p_league_season_id: seasonId, p_week_number: week }))
  const stale = () => q(supabase.rpc('get_stale_score_weeks', { p_league_season_id: seasonId, p_through_week: 25 }))
  const close = async () => {
    await q(supabase.from('leagues').delete().eq('id', league))
    await q(supabase.from('player_game_stats').delete().in('game_id', games))
    if (games.length) await q(supabase.from('nba_games').delete().in('id', games))
    await q(supabase.from('players').delete().in('id', players))
    await q(supabase.from('season_weeks').delete().eq('season_year', year))
    for (const user of users) { const result = await supabase.auth.admin.deleteUser(user); if (result.error) throw result.error }
    for (const entry of providerGames.values()) if (games.includes(entry.game)) providerGames.delete(entry.provider)
  }
  const userClient = createClient(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  return { league, seasonId, members, players, year, weeks, weekFor, matchup, game, lineup, read, capture, stale, close, userClient, users, password }
}
