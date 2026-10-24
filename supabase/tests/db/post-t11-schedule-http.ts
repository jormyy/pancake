import assert from 'node:assert/strict'

// Served-path schedule oracle: the calendar is published only by an HTTP POST to
// the real `sync-schedule` Edge function served by the local stack, and playoff
// fit is read only from the real `api` function (POST /league/playoff-fit). The
// NBA CDN is a local fake serving the REAL-DERIVED pinned schedules in
// tests/fixtures/calendar in the CDN schedule format. The served worker checks
// freshness against the real clock, so every date moves by whole weeks into a
// future season (a SYNTHETIC transform that keeps weekdays, gaps and NBA weeks)
// and every game is unplayed. Expected dates are the pinned real values of
// calendar-seasons.ts moved by the same number of days. Assertions read the HTTP
// responses, the worker's sync_runs rows and the persisted nba_games and season_weeks.
const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT'))
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT'))
// The served Edge env points NBA_CDN_BASE_URL at this port (the API port + 70).
const cdnPort = Number(new URL(api).port) + 70
for (const port of [new URL(api).port, new URL(db).port, String(cdnPort)]) assert.ok(!/^(543|582)\d\d$/.test(port), `Port ${port} belongs to a protected stack`)
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
const secret = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!
const publishable = Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY')!
for (const value of [token, secret, publishable]) assert.ok(value)
const sql = async (statement: string): Promise<string> => {
  const child = new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const check = async (condition: string, label: string) => {
  assert.equal(await sql(`SELECT (${condition})::text`), 'true', label)
  console.log(`PASS ${label}`)
}

type FixtureGame = { gameId: string; gameDate: string; homeTeam: string; awayTeam: string; statusText: string; startedAt: string | null; weekNumber: number; notes: { headline?: string }[]; cupFinal: boolean }
type Payload = { leagueSchedule: { seasonYear: string; gameDates: { gameDate: string; games: unknown[] }[] } }
const schedulePath = '/static/json/staticData/scheduleLeagueV2_1.json'
let payload: Payload | null = null
const requests: string[] = []
const cdn = Deno.serve({ hostname: '127.0.0.1', port: cdnPort, onListen() {} }, request => {
  const path = new URL(request.url).pathname
  requests.push(`${request.method} ${path}`)
  return request.method === 'GET' && path === schedulePath && payload ? Response.json(payload) : new Response('Not found', { status: 404 })
})

const day = 86_400_000
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * day).toISOString().slice(0, 10)
const fixture = async (name: string): Promise<FixtureGame[]> => {
  const pinned = JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/calendar/${name}`, import.meta.url)))
  assert.equal(pinned.provenance, 'REAL-DERIVED')
  return pinned.games
}
// The NBA CDN schedule shape fetchSeasonSchedule parses, grouped by game day.
function cdnPayload(games: FixtureGame[], days: number, label: string): Payload {
  const byDate = new Map<string, unknown[]>()
  for (const game of games) {
    const date = shift(game.gameDate, days)
    const postponed = game.statusText === 'Postponed'
    byDate.set(date, [...(byDate.get(date) ?? []), {
      gameId: game.gameId, gameDateEst: `${date}T00:00:00Z`, gameDateTimeUTC: game.startedAt && new Date(Date.parse(game.startedAt) + days * day).toISOString(),
      gameStatus: 1, gameStatusText: '', postponedStatus: postponed ? 'Y' : 'N', weekNumber: game.weekNumber,
      homeTeam: { teamTricode: game.homeTeam }, awayTeam: { teamTricode: game.awayTeam },
    }])
  }
  return { leagueSchedule: { seasonYear: label, gameDates: [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([gameDate, list]) => ({ gameDate, games: list })) } }
}

// Whole-week shifts: 2025-26 + 104 weeks is season 2028, 2024-25 + 208 weeks is 2029, 2025-26 + 208 weeks is 2030.
const seasons = {
  2028: { fixture: 'espn-2025-2026.json', days: 728, label: '2027-28', opening: '2025-10-21', weekOneEnd: '2025-10-26', allStar: ['2026-02-09', '2026-02-22'], weekTwenty: '2026-03-09', cupFinal: '0062500001' },
  2029: { fixture: 'espn-2024-2025.json', days: 1456, label: '2028-29', opening: '2024-10-22', weekOneEnd: '2024-10-27', allStar: ['2025-02-10', '2025-02-23'], weekTwenty: '2025-03-10', cupFinal: '0062400001' },
  2030: { fixture: 'espn-2025-2026.json', days: 1456, label: '2029-30', opening: '2025-10-21', weekOneEnd: '2025-10-26', allStar: ['2026-02-09', '2026-02-22'], weekTwenty: '2026-03-09', cupFinal: '0062500001' },
} as const
type Year = keyof typeof seasons
const syncRuns = () => sql(`SELECT count(*)||'/'||count(*) FILTER (WHERE status='success') FROM sync_runs WHERE function_name='sync-schedule'`)

async function sync(label: string, next: Payload) {
  const [runs, successes] = (await syncRuns()).split('/').map(Number)
  const before = requests.length
  payload = next
  const response = await fetch(`${api}/functions/v1/sync-schedule`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': token }, body: '{}' })
  const text = await response.text()
  payload = null
  if (response.status !== 200) {
    const recorded = await sql(`SELECT status||': '||coalesce(error,'') FROM sync_runs WHERE function_name='sync-schedule' ORDER BY started_at DESC LIMIT 1`)
    assert.fail(`${label}: HTTP ${response.status} ${text}; the served worker recorded ${recorded}`)
  }
  const body = JSON.parse(text) as { ok: boolean; updated: number; inserted: number; weeks: number }
  console.log(JSON.stringify({ provenance: 'REAL-DERIVED, date-shifted (SYNTHETIC transform)', path: 'edge-http:sync-schedule', label, result: body }))
  assert.equal(body.ok, true)
  const fetched = requests.slice(before)
  assert.ok(fetched.length >= 1 && fetched.every(request => request === `GET ${schedulePath}`), `${label}: the served worker reads only the fake CDN schedule (${fetched.join(', ')})`)
  assert.equal(await syncRuns(), `${runs + 1}/${successes + 1}`, `${label}: the served worker records one successful sync run`)
  return body
}
const inOwnWeeks = (year: number) => `NOT EXISTS(SELECT 1 FROM nba_games game WHERE game.season_year=${year} AND NOT EXISTS(SELECT 1 FROM season_weeks week
  WHERE week.season_year=${year} AND week.week_number=game.week_number AND game.game_date BETWEEN week.week_start AND week.week_end))`
const disjoint = (year: number) => `NOT EXISTS(SELECT 1 FROM season_weeks a JOIN season_weeks b ON a.season_year=b.season_year AND a.week_number<b.week_number
  WHERE a.season_year=${year} AND a.week_end>=b.week_start)`
const range = (year: number, week: number, start: string, end: string) => `(SELECT (week_start,week_end)=(${q(start)}::date,${q(end)}::date) FROM season_weeks WHERE season_year=${year} AND week_number=${week})`

// Opening night, the merged All-Star week and the NBA Cup final, read back from the persisted calendar.
async function calendar(year: Year) {
  const season = seasons[year]
  const games = await fixture(season.fixture)
  const regular = games.filter(game => !game.cupFinal)
  assert.deepEqual(games.filter(game => game.cupFinal).map(game => game.gameId), [season.cupFinal])
  const result = await sync(`calendar ${year}`, cdnPayload(games, season.days, season.label))
  assert.deepEqual(result, { ok: true, updated: 0, inserted: regular.length, weeks: 24 }, `calendar ${year}: every regular-season game and 24 fantasy weeks are published`)
  const opening = shift(season.opening, season.days)
  await check(`(SELECT min(game_date) FROM nba_games WHERE season_year=${year})=${q(opening)}::date`, `${year} opening: the first persisted regular-season day is opening night ${opening}`)
  await check(`(SELECT count(*) FROM nba_games WHERE season_year=${year} AND game_date=${q(opening)} AND week_number=1)=2`, `${year} opening: both opening-night games are in week 1`)
  await check(range(year, 1, opening, shift(season.weekOneEnd, season.days)), `${year} opening: week 1 runs from opening night to its first Sunday`)
  const [first, last] = season.allStar.map(date => shift(date, season.days))
  await check(`(SELECT count(*)=24 AND min(week_number)=1 AND max(week_number)=24 FROM season_weeks WHERE season_year=${year})`, `${year} all-star: 24 fantasy weeks`)
  await check(range(year, 17, first, last), `${year} all-star: the two NBA weeks around the break form week 17 (${first}..${last})`)
  await check(`(SELECT week_start=${q(shift(season.weekTwenty, season.days))}::date FROM season_weeks WHERE season_year=${year} AND week_number=20)`, `${year} all-star: later weeks keep the merged numbering`)
  await check(`${inOwnWeeks(year)} AND ${disjoint(year)}`, `${year} all-star: every persisted game lies in its own disjoint fantasy week`)
  const cup = regular.filter(game => game.notes.some(note => /cup/i.test(note.headline ?? '')))
  assert.ok(cup.length >= 2)
  await check(`NOT EXISTS(SELECT 1 FROM nba_games WHERE nba_game_id=${q(season.cupFinal)})`, `${year} cup: the NBA Cup final ${season.cupFinal} is excluded`)
  await check(`(SELECT count(*) FROM nba_games WHERE season_year=${year} AND nba_game_id IN(${cup.map(game => q(game.gameId)).join(',')}))=${cup.length}`, `${year} cup: the ${cup.length} other NBA Cup games are regular-season games`)
  await check(`(SELECT count(*) FROM nba_games WHERE season_year=${year})=${regular.length}`, `${year} cup: only the final is left out`)
}

const authPost = async (path: string, headers: Record<string, string>, body: unknown) => {
  const response = await fetch(`${api}/auth/v1${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  assert.ok(response.ok, `${path}: ${response.status} ${text}`)
  return JSON.parse(text)
}

// The commissioner's served fit check on the calendar the served worker published.
async function fit(year: Year, league: string, users: string[]) {
  const season = seasons[year]
  await sync(`fit ${year}`, cdnPayload(await fixture(season.fixture), season.days, season.label))
  await check(`(SELECT count(*)=24 FROM season_weeks WHERE season_year=${year})`, `fit ${year}: the served calendar has 24 weeks`)
  const email = `post-t11-${crypto.randomUUID()}@example.test`, password = crypto.randomUUID()
  const user = await authPost('/admin/users', { apikey: secret, authorization: `Bearer ${secret}` }, { email, password, email_confirm: true })
  users.push(user.id)
  const session = await authPost('/token?grant_type=password', { apikey: publishable }, { email, password })
  await sql(`BEGIN;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths)
      VALUES(${q(league)},'Synthetic served playoff fit',${q(league)},${q(user.id)},'setup',20,2,ARRAY[2]);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(gen_random_uuid(),${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(gen_random_uuid(),${q(league)},${q(user.id)},'commissioner','Synthetic');
    COMMIT;`)
  const served = async (start: number, rounds: number[]) => {
    const response = await fetch(`${api}/functions/v1/api/league/playoff-fit`, { method: 'POST',
      headers: { apikey: publishable, authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ leagueId: league, start, rounds }) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const body = JSON.parse(text)
    console.log(JSON.stringify({ path: 'edge-http:api/league/playoff-fit', season: year, start, rounds, result: body }))
    return body
  }
  assert.deepEqual(await served(20, [1, 2, 2]), { status: 'fit', lastAvailableWeek: 24, requiredWeeks: 5, endWeek: 24 }, `fit ${year}: playoffs from week 20 over rounds 1+2+2 end in the last published week`)
  console.log(`PASS fit ${year}: start 20 rounds [1,2,2] fits`)
  // The settings screen refuses to save and warns whenever the served status is not 'fit'.
  assert.deepEqual(await served(21, [1, 2, 2]), { status: 'does-not-fit', lastAvailableWeek: 24, requiredWeeks: 5, endWeek: 25 }, `fit ${year}: playoffs from week 21 run past the last published week`)
  console.log(`PASS fit ${year}: start 21 rounds [1,2,2] does not fit (warning)`)
}

// SYNTHETIC control from the real schedule: without the games of one November
// Sunday, the one empty day across Monday must not count as a second break.
async function sundayGap(year: Year) {
  const season = seasons[year]
  const sunday = '2025-11-23'
  assert.equal(season.fixture, 'espn-2025-2026.json')
  const games = (await fixture(season.fixture)).filter(game => game.gameDate !== sunday)
  const result = await sync(`sunday-gap ${year}`, cdnPayload(games, season.days, season.label))
  assert.deepEqual(result, { ok: true, updated: 0, inserted: games.length - 1, weeks: 24 }, `sunday-gap ${year}: the schedule without ${shift(sunday, season.days)} still publishes 24 fantasy weeks`)
  await check(`${range(year, 5, shift('2025-11-17', season.days), shift('2025-11-22', season.days))} AND ${range(year, 6, shift('2025-11-24', season.days), shift('2025-11-30', season.days))}`,
    `sunday-gap ${year}: weeks 5 and 6 stay separate NBA weeks across the empty Sunday`)
  const [first, last] = season.allStar.map(date => shift(date, season.days))
  await check(range(year, 17, first, last), `sunday-gap ${year}: the All-Star break is still the only merge (week 17 ${first}..${last})`)
  await check(`${inOwnWeeks(year)} AND ${disjoint(year)}`, `sunday-gap ${year}: every persisted game lies in its own disjoint fantasy week`)
}

// A calendar published from a partial first snapshot (SYNTHETIC: the first four
// NBA weeks of the real schedule) stays exact when the complete schedule arrives.
async function republish(year: Year) {
  const season = seasons[year]
  const games = await fixture(season.fixture)
  const partial = games.filter(game => game.weekNumber <= 4)
  assert.ok(partial.length > 0 && partial.every(game => !game.cupFinal))
  const first = await sync(`republish ${year} partial`, cdnPayload(partial, season.days, season.label))
  assert.deepEqual(first, { ok: true, updated: 0, inserted: partial.length, weeks: 4 }, `republish ${year}: the partial snapshot publishes four weeks`)
  const weeks = `SELECT coalesce(json_agg(json_build_array(week_number,week_start,week_end) ORDER BY week_number),'[]') FROM season_weeks WHERE season_year=${year} AND week_number<=4`
  const published = await sql(weeks)
  await check(range(year, 1, shift(season.opening, season.days), shift(season.weekOneEnd, season.days)), `republish ${year}: week 1 is published from the partial snapshot`)
  const complete = await sync(`republish ${year} complete`, cdnPayload(games, season.days, season.label))
  assert.equal(complete.updated, partial.length)
  assert.equal(complete.inserted, games.length - 1 - partial.length)
  assert.equal(await sql(weeks), published, `republish ${year}: the complete daily sync keeps the published weeks exactly`)
  await check(`${inOwnWeeks(year)} AND ${disjoint(year)}`, `republish ${year}: every persisted game lies in its own disjoint fantasy week`)
}

const cases = ['calendar', 'sunday-gap', 'fit', 'republish'] as const
const selected = Deno.env.get('POST_SCHEDULE_CASE')
assert.ok(!selected || (cases as readonly string[]).includes(selected))
const years: Record<typeof cases[number], Year[]> = { calendar: [2028, 2029], 'sunday-gap': [2028], fit: [2028], republish: [2030] }
const failures: string[] = []
for (const name of cases.filter(value => !selected || value === selected)) {
  const league = crypto.randomUUID()
  const users: string[] = []
  const list = years[name].join(',')
  try {
    assert.equal(await sql(`SELECT (SELECT count(*) FROM season_weeks WHERE season_year IN(${list}))+(SELECT count(*) FROM nba_games WHERE season_year IN(${list}))
      +(SELECT count(*) FROM league_seasons WHERE season_year IN(${list}))`), '0', `Season years ${list} are occupied`)
    if (name === 'calendar') for (const year of years.calendar) await calendar(year)
    else if (name === 'sunday-gap') await sundayGap(2028)
    else if (name === 'fit') await fit(2028, league, users)
    else await republish(2030)
    console.log(`PASS ${name}: served schedule path`)
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`)
  } finally {
    await sql(`BEGIN;
      DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM nba_games WHERE season_year IN(${list});
      DELETE FROM season_weeks WHERE season_year IN(${list});
      ${users.length ? `DELETE FROM auth.users WHERE id IN(${users.map(q).join(',')});` : ''}
      COMMIT;`)
  }
}
await cdn.shutdown()
assert.deepEqual(failures, [])
Deno.exit(0)
