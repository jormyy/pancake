import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const token = crypto.randomUUID().replaceAll('-', '')
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members = [crypto.randomUUID(), crypto.randomUUID()]
const players = [crypto.randomUUID(), crypto.randomUUID()]
const games = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
const users: string[] = []
const keys = games.map((_, index) => `002-postponed-${token}-${index}`)
const requests: string[] = []
let scheduleGame: Record<string, unknown> = {}
let providerMode = 'scheduled'
let homePoints = 3
function boxPlayer(side: number) {
    return { personId: 907770001 + side, name: side ? 'Postponed Away' : 'Postponed Home', played: '1', statistics: {
        minutes: 'PT20M00.00S', points: side ? 6 : homePoints, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0, assists: 0,
        steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0,
        threePointersMade: 0, threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0,
    } }
}
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.endsWith('scheduleLeagueV2_1.json')) return Response.json({ leagueSchedule: { gameDates: [{ games: [scheduleGame] }] } })
    assert.equal(path, `/liveData/boxscore/boxscore_${keys[2]}.json`)
    return Response.json({ game: { gameId: keys[2], gameStatus: providerMode === 'scheduled' ? 1 : 3,
        homeTeam: { players: providerMode === 'scheduled' ? [] : [boxPlayer(0)] },
        awayTeam: { players: providerMode === 'scheduled' ? [] : [boxPlayer(1)] },
    } })
})
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
Deno.env.set('NBA_CDN_BASE_URL', providerOrigin)
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    assert.ok([api, providerOrigin].includes(url.origin), 'Only owned local services receive requests')
    return nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { fetchSeasonSchedule } = await import('../../functions/_shared/nba.ts')
const { buildScheduleSyncPlan } = await import('../../functions/_shared/schedule.ts')
async function query<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
let year = 0
try {
    for (let candidate = 2021; candidate < 2500; candidate++) {
        const weeks = await query(supabase.from('season_weeks').select('id').eq('season_year', candidate))
        const seasons = await query(supabase.from('league_seasons').select('id').eq('season_year', candidate))
        if (!weeks?.length && !seasons?.length) { year = candidate; break }
    }
    assert.ok(year)
    const first = `${year - 1}-10-15`
    const dateForWeek = (week: number) => addDays(first, (week - 1) * 7 + 2)
    const reference = new Date(`${addDays(first, 21)}T12:00:00Z`)
    for (let side = 0; side < 2; side++) {
        const { data, error } = await supabase.auth.admin.createUser({
            email: `postponed-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
            user_metadata: { username: `postponed_${token.slice(0, 12)}_${side}` },
        })
        if (error) throw error
        assert.ok(data.user); users.push(data.user.id)
    }
    await query(supabase.from('leagues').insert({ id: league, slug: `postponed-${token}`, name: 'Owned postponed scoring',
        commissioner_id: users[0], status: 'active', team_limit: 2, playoff_start_week: 3, playoff_entrants: 2,
        playoff_round_lengths: [1], scoring_settings: { points: 1 } }))
    await query(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league,
        user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Postponed ${side}` }))))
    await query(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
    await query(supabase.from('season_weeks').insert([1, 2, 3].map(week => ({ season_year: year, week_number: week,
        week_start: addDays(first, (week - 1) * 7), week_end: addDays(first, week * 7 - 1) }))))
    await query(supabase.from('players').insert(players.map((id, side) => ({ id, first_name: 'Postponed', last_name: side ? 'Away' : 'Home',
        position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS', nba_id: String(907770001 + side) }))))
    await query(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, member_id: members[side],
        league_id: league, league_season_id: season, acquired_via: 'draft', acquired_at: `${first}T00:00:00Z` }))))
    await query(supabase.from('nba_games').insert(games.map((id, index) => ({ id, nba_game_id: keys[index], season_year: year,
        game_date: dateForWeek(index === 1 ? 2 : 1), week_number: index === 1 ? 2 : 1, home_team: 'BOS', away_team: 'MIA',
        status: index === 2 ? 'Scheduled' : 'Final', game_status_text: index === 2 ? '' : 'Final',
        stats_synced_at: index === 2 ? null : new Date().toISOString() }))))
    for (const week of [1, 2]) {
        await query(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: games[week - 1],
            season_year: year, week_number: week, game_date: dateForWeek(week), points: side ? 5 : 10, did_not_play: false }))))
        await query(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, member_id: members[side],
            league_id: league, league_season_id: season, week_number: week, game_date: dateForWeek(week), slot_type: 'PG' as const }))))
        await query(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: week,
            home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season' }))
    }
    await syncScores(league, reference)
    const pending = await query(supabase.from('matchups').select('is_finalized').eq('league_season_id', season))
    assert.ok(pending?.every(row => !row.is_finalized), 'A scheduled game still blocks incomplete records')
    assert.ok(requests.length > 0)
    requests.length = 0
    scheduleGame = { gameId: keys[2], gameDateEst: `${dateForWeek(1)}T00:00:00`, gameStatus: 1, gameStatusText: 'PPD - postponed',
        weekNumber: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'MIA' } }
    const postponedPlan = buildScheduleSyncPlan(await fetchSeasonSchedule(), new Date(`${first}T00:00:00Z`))
    await query(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: postponedPlan.rows, p_weeks: postponedPlan.weeks }))
    assert.equal((await query(supabase.from('nba_games').select('game_status_text').eq('id', games[2]).single()))?.game_status_text, 'PPD - postponed')
    requests.length = 0
    await syncScores(league, reference)
    const matchups = await query(supabase.from('matchups').select('week_number,is_finalized,home_points,away_points').eq('league_season_id', season).order('week_number'))
    assert.ok(matchups)
    assert.equal(matchups.length, 2)
    assert.ok(matchups.every(row => row.is_finalized), 'A postponed game cannot block its week or later standings')
    assert.deepEqual(matchups.map(row => [row.home_points, row.away_points]), [[10, 5], [10, 5]])
    assert.equal(requests.length, 0, 'Unavailable games cause no box-score reads')
    const standing = await query(supabase.from('standings').select('wins,losses,ties').eq('league_season_id', season).eq('week_number', 2).eq('member_id', members[0]).single())
    assert.deepEqual(standing, { wins: 2, losses: 0, ties: 0 })
    await query(supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: league }))
    const bracket = await query(supabase.from('matchups').select('week_number,home_member_id,away_member_id').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single())
    assert.equal(bracket?.week_number, 3)
    assert.equal(bracket?.home_member_id, members[0])
    console.log(JSON.stringify({ case: 'postponed game permits both regular weeks and seeded final', matchups, standing, bracket, providerReads: requests.length }))
    const legacyGame = { nba_game_id: keys[2], season_year: year, game_date: dateForWeek(1), week_number: 1, status: 'Scheduled', home_team: 'BOS', away_team: 'MIA' }
    await query(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: [legacyGame], p_weeks: [] }))
    assert.equal((await query(supabase.from('nba_games').select('game_status_text').eq('id', games[2]).single()))?.game_status_text, 'PPD - postponed', 'Missing provider text preserves a known postponed marker on the same schedule')
    const rescheduledDate = addDays(dateForWeek(3), 3)
    await query(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: [{ ...legacyGame, game_date: rescheduledDate,
        week_number: 3, game_time: `${rescheduledDate}T23:00:00Z`, started_at: `${rescheduledDate}T23:00:00Z` }], p_weeks: [] }))
    assert.equal((await query(supabase.from('nba_games').select('game_status_text').eq('id', games[2]).single()))?.game_status_text, null, 'A genuine reschedule clears a stale unavailable marker even without provider text')

    scheduleGame = { gameId: keys[2], gameDateEst: `${rescheduledDate}T00:00:00`, gameDateTimeUTC: `${rescheduledDate}T23:00:00Z`,
        gameStatus: 1, gameStatusText: '7:00 PM ET', weekNumber: 3, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'MIA' } }
    const plan = buildScheduleSyncPlan(await fetchSeasonSchedule(), new Date(`${first}T00:00:00Z`))
    assert.equal(Reflect.get(plan.rows[0], 'game_status_text'), '7:00 PM ET')
    await query(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: plan.rows, p_weeks: plan.weeks }))
    const rescheduled = await query(supabase.from('nba_games').select('id,week_number,game_date,game_status_text').eq('id', games[2]).single())
    assert.deepEqual(rescheduled, { id: games[2], week_number: 3, game_date: rescheduledDate, game_status_text: '7:00 PM ET' })
    await query(supabase.from('leagues').update({ status: 'playoffs' }).eq('id', league))
    await query(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, member_id: members[side],
        league_id: league, league_season_id: season, week_number: 3, game_date: rescheduledDate, slot_type: 'PG' as const }))))
    await syncScores(league, reference)
    assert.equal((await query(supabase.from('matchups').select('is_finalized').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single()))?.is_finalized, false)
    await query(supabase.from('nba_games').update({ status: 'Final', stats_synced_at: null }).eq('id', games[2]))
    await assert.rejects(syncScores(league, reference), /Score sync failed/)
    assert.equal((await query(supabase.from('matchups').select('is_finalized').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single()))?.is_finalized, false)
    providerMode = 'recovered'
    await syncScores(league, reference)
    const final = await query(supabase.from('matchups').select('winner_member_id,home_points,away_points,is_finalized').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single())
    assert.deepEqual(final, { winner_member_id: members[1], home_points: 3, away_points: 6, is_finalized: true })
    homePoints = 9
    await query(supabase.from('nba_games').update({ stats_synced_at: new Date(Date.now() - 31 * 60000).toISOString() }).eq('id', games[2]))
    await syncScores(league, reference)
    const correction = await query(supabase.from('matchups').select('winner_member_id,home_points,away_points').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single())
    assert.deepEqual(correction, { winner_member_id: members[0], home_points: 9, away_points: 6 })
    assert.equal((await query(supabase.from('nba_games').select('id').in('id', games)))?.length, 3)
    assert.equal((await query(supabase.from('player_game_stats').select('id').in('game_id', games)))?.length, 6)
    assert.deepEqual(await query(supabase.from('standings').select('wins,losses,ties').eq('league_season_id', season).eq('week_number', 2).eq('member_id', members[0]).single()), standing)
    console.log(JSON.stringify({ case: 'real schedule resumption, missing-final refusal, recovery and correction preserve prior history', rescheduled, final, correction }))
} finally {
    await query(supabase.from('leagues').delete().eq('id', league))
    await query(supabase.from('player_game_stats').delete().in('game_id', games))
    await query(supabase.from('nba_games').delete().in('id', games))
    await query(supabase.from('players').delete().in('id', players))
    if (year) await query(supabase.from('season_weeks').delete().eq('season_year', year))
    for (const user of users) { const { error } = await supabase.auth.admin.deleteUser(user); if (error) throw error }
    globalThis.fetch = nativeFetch
    await provider.shutdown()
    console.log(JSON.stringify({ cleanup: 'owned postponed-scoring fixture removed' }))
}
