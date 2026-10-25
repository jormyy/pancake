import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type OutboxRow } from './notif-t9-support.ts'

// The real sync-players handler against a local synthetic ESPN/NBA feed (its
// SLEEPER/ESPN/NBA base URL env seams), into resolve_player_imports_atomic and
// the owned-player trigger. Every other player's career fields are served back
// unchanged and their check timestamps restored, so the shared test DB keeps
// its state.
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const file = 'supabase/tests/db/notif-t10-sync-players.ts'
const run = crypto.randomUUID().slice(0, 8)
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const athletes = Array.from({ length: codes.length * 12 }, (_, index) => ({ id: crypto.randomUUID(), espn: `notif-t10-${run}-${index}`, team: Math.floor(index / 12), last: `T10${run}n${index}` }))
const [owned, foreign, free] = athletes
let feed = new Map<string, string>()
let career = new Map<string, number | null>()
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), stats = route.match(/^\/career\/athletes\/([^/]+)\/stats$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map((abbreviation, index) => ({ team: { id: String(index + 1), abbreviation } })) }] }] })
  if (roster) return Response.json({ athletes: athletes.filter(athlete => athlete.team === Number(roster[1]) - 1).map(athlete => ({ id: athlete.espn, firstName: 'Synthetic', lastName: athlete.last, fullName: `Synthetic ${athlete.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 0 } })) })
  if (route === '/site/injuries') return Response.json({ injuries: [{ injuries: [...feed].map(([last, status]) => ({ status, athlete: { displayName: `Synthetic ${last}` } })) }] })
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [] }] })
  if (stats) {
    const games = career.get(decodeURIComponent(stats[1]))
    return Response.json(games === undefined || games === null ? {} : { filters: [{ name: 'seasontype', value: '2' }, { name: 'league', value: 'nba' }], categories: [{ names: ['gamesPlayed'], totals: [String(games)] }] })
  }
  return new Response('synthetic provider has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${provider.addr.port}`
Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
Deno.env.set('ESPN_SITE_BASE_URL', `${origin}/site`)
Deno.env.set('ESPN_CAREER_BASE_URL', `${origin}/career`)
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)
Deno.env.set('SLEEPER_BASE_URL', `${origin}/sleeper`)
let checked = '[]'
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  transport.origins.push(origin)
  fixture.players.push(...athletes.map(athlete => athlete.id))
  await sql(`INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,nba_draft_number,espn_id,injury_status)
    SELECT id,'Synthetic',last,'PG',ARRAY['PG'],'Active','BOS',0,1,espn,CASE WHEN espn=${q(foreign.espn)} THEN 'Out' END
    FROM json_to_recordset(${q(JSON.stringify(athletes))}) a(id uuid,espn text,last text)`)
  checked = await sql(`SELECT COALESCE(json_agg(json_build_object('id',id,'at',career_games_checked_at)),'[]') FROM players WHERE espn_id IS NOT NULL AND NOT id=ANY(ARRAY[${athletes.map(athlete => q(athlete.id))}]::uuid[])`)
  career = new Map(Object.entries(JSON.parse(await sql(`SELECT json_object_agg(espn_id,career_regular_season_games) FROM players WHERE espn_id IS NOT NULL`))))
  const owners: string[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    owners.push(league.members[rotation])
    await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league.id)},${q(league.season)},${q(league.members[rotation])},${q(owned.id)},'draft')`)
  }
  await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT ${q(fixture.foreignLeague)},id,${q(fixture.foreignMembers[0])},${q(foreign.id)},'draft' FROM league_seasons WHERE league_id=${q(fixture.foreignLeague)} AND is_current`)
  const worker = await transport.serve(() => import('../../functions/sync-players/index.ts'))
  const sync = async () => {
    const response = await transport.invoke(worker)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.ok, true)
    assert.equal(response.body.inserted, 0, 'Every synthetic athlete resolves to its existing espn_id player')
  }
  const states = [
    { owned: 'Out', free: 'Out', stored: 'Out', events: ['owned_player_status', 'owned_player_injured', 'owned_player_ruled_out'] },
    { owned: 'Day-To-Day', free: 'Questionable', stored: 'DTD', events: ['owned_player_status', 'owned_player_injured'] },
    { owned: null, free: null, stored: '', events: ['owned_player_status'] },
  ]
  const scope = `data->>'playerId'=${q(owned.id)}`
  for (const state of states) {
    const before = JSON.parse(await sql(`SELECT COALESCE(json_agg(id),'[]') FROM notification_outbox WHERE ${scope}`)) as string[]
    feed = new Map([[foreign.last, 'Out'], ...(state.owned ? [[owned.last, state.owned]] : []), ...(state.free ? [[free.last, state.free]] : [])] as [string, string][])
    await sync()
    assert.equal(await sql(`SELECT injury_status FROM players WHERE id=${q(owned.id)}`), state.stored, 'The feed reached the owned player row')
    assert.equal(await sql(`SELECT injury_status FROM players WHERE id=${q(free.id)}`), state.free ? (state.free === 'Out' ? 'Out' : 'Questionable') : '', 'The feed reached the free agent row')
    const fresh = scope + (before.length ? ` AND id NOT IN (${before.map(q)})` : '')
    const batch: OutboxRow[] = []
    for (const event of state.events) batch.push(...await expectRows(event, fresh, owners, sync))
    for (const event of ['owned_player_injured', 'owned_player_ruled_out'].filter(event => !state.events.includes(event))) assert.equal((await rows(event, fresh)).length, 0, `${state.stored || 'Available'} is not ${event}`)
    assert.ok(batch.filter(row => row.event_type === 'owned_player_status').every(row => row.data.body === `Synthetic ${owned.last}: ${state.stored || 'Available'}`))
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE data->>'playerId' IN (${q(free.id)},${q(foreign.id)})`), '0', 'A free agent and an unchanged foreign-owned player notify nobody')
    await transport.prove(fixture, batch, `${file}#${state.stored || 'Available'}`, 'edge-http:sync-players + trigger')
  }
  assert.equal(await sql(`SELECT count(*) FROM players WHERE espn_id LIKE ${q(`notif-t10-${run}-%`)}`), String(athletes.length), 'The sync inserted no duplicate players')
  console.log('SYNTHETIC: real sync-players handler with a local fake ESPN/NBA/career feed, resolve_player_imports_atomic, owned-player Out/DTD/Available status, exact owners, foreign owner of another player, non-owner and free-agent negatives, repeated-feed dedupe, all send-time switches and receipts')
} finally {
  try {
    await transport.close()
    await provider.shutdown()
    if (checked !== '[]') await sql(`UPDATE players p SET career_games_checked_at=s.at FROM json_to_recordset(${q(checked)}) s(id uuid,at timestamptz) WHERE p.id=s.id`)
    await fixture.cleanup()
  } finally {
    await clock.restore()
  }
}
