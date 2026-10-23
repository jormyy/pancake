import assert from 'node:assert/strict'
import test from 'node:test'
import { twoPlan, areaCheck, draftSourceUnavailable, assertTwoDay } from './two-checks.mjs'

test('legacy runs do not select the real two-season leg implicitly', async () => {
  assert.equal(await twoPlan(), null)
})

test('a missing rookie game is an area failure rather than an unmeasured result', () => {
  assert.throws(() => areaCheck('rookie-identity', () => assert.fail('Missing rookie game')), error => error instanceof Error&&'area' in error&&error.area === 'rookie-identity')
})

test('declared draft input unavailability cannot hide an unrelated worker failure',()=>{
  const time=Date.parse('2025-06-20T13:00:00Z'),available='2025-06-28T00:00:00Z'
  assert.ok(draftSourceUnavailable('sync-draft-order',time,available,'Could not load a complete board. NBA.com 503'))
  assert.equal(draftSourceUnavailable('sync-draft-order',time,available,'SQL syntax error'),false)
  assert.equal(draftSourceUnavailable('sync-draft-order',Date.parse(available),available,'Could not load a complete board. 503'),false)
})

test('every NBA-moved subject is checked each day, so a later subject is verified while an earlier one is not yet due', async () => {
  // REAL-RAW box slices (six scoring categories) of the pinned 2025-26 inputs: Clayton's first two games for MEM and Harden's
  // first for CLE. Subjects are in nbaTradeSetup's order (the plan's deadline trade first); owners and starts are SYNTHETIC.
  const line = (personId, name, [points, reboundsTotal, assists, steals, blocks, turnovers]) => ({ personId, name, statistics: { points, reboundsTotal, assists, steals, blocks, turnovers } })
  const boxes = {
    '0022500745': { home: 'POR', away: 'MEM', date: '2026-02-06', player: line(1642383, 'Walter Clayton Jr.', [11, 3, 4, 1, 0, 3]), id: 'clayton', points: 20.6 },
    '0022500755': { home: 'POR', away: 'MEM', date: '2026-02-07', player: line(1642383, 'Walter Clayton Jr.', [8, 4, 7, 3, 0, 2]), id: 'clayton', points: 30.3 },
    '0022500756': { home: 'SAC', away: 'CLE', date: '2026-02-07', player: line(201935, 'James Harden', [23, 2, 8, 1, 0, 3]), id: 'harden', points: 37.4 },
  }
  const settings = { points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1 }
  const players = [{ id: 'harden', nba_id: 201935, display_name: 'James Harden', nba_team: 'CLE' }, { id: 'clayton', nba_id: 1642383, display_name: 'Walter Clayton Jr.', nba_team: 'MEM' }, { id: 'tonje', nba_id: 1642910, display_name: 'John Tonje', nba_team: 'BOS' }]
  const roster = [{ player_id: 'harden', member_id: 'a' }, { player_id: 'clayton', member_id: 'b' }, { player_id: 'tonje', member_id: 'c' }]
  const games = date => Object.entries(boxes).filter(([, row]) => row.date === date)
  const input = date => ({
    players, settings,
    stats: games(date).map(([gameId, row]) => ({ player_id: row.id, nba_game_id: gameId })),
    fantasy: games(date).map(([gameId, row]) => ({ player_id: row.id, nba_game_id: gameId, fantasy_points: row.points })),
    lineups: [{ player_id: 'clayton', game_date: '2026-02-06', member_id: 'b', slot_type: 'UTIL' }, { player_id: 'harden', game_date: '2026-02-07', member_id: 'a', slot_type: 'UTIL' }].filter(row => row.game_date === date),
  })
  const query = async statement => statement.includes('FROM nba_games g WHERE season_year') ? [] : input(/game_date='([\d-]+)'/.exec(statement)[1])
  const writes = [], write = async file => { writes.push(file.split('/').at(-1)) }
  const c = {
    seasonYear: 2026, leagueId: 'L', leagueSeasonId: 'S', users: [{ memberId: 'a' }],
    nbaTradeSubjects: [
      { year: 2026, nbaId: '201935', from: 'LAC', to: 'CLE', firstAfter: '2026-02-07', playerId: 'harden', owner: 'a', at: '2026-01-01' },
      { year: 2026, nbaId: '1642383', from: 'UTA', to: 'MEM', movedOn: '2026-02-04', firstAfter: '2026-02-06', playerId: 'clayton', owner: 'b', at: '2026-01-01' },
      { year: 2026, nbaId: '1642910', from: 'UTA', to: 'BOS', movedOn: '2026-02-06', firstAfter: '2026-02-24', playerId: 'tonje', owner: 'c', at: '2026-01-01' },
    ],
    rookiePreferences: [{ date: '2026-02-06', playerId: 'clayton', nbaId: '1642383', owner: 'b', starter: true }, { date: '2026-02-07', playerId: 'harden', nbaId: '201935', owner: 'a', starter: true }],
    rest: async (_user, path) => path.startsWith('matchups?') ? [] : path.startsWith('roster_players?') ? roster.map(row => ({ ...row })) : players.filter(row => path.endsWith(`nba_id=eq.${row.nba_id}`)),
  }
  const plan = { seasons: [{ year: 2025 }, { year: 2026, start: '2025-10-21', end: '2026-04-12', calendar: { weeks: [] } }], postponements: { timelines: [] }, draft: { rookies: [] } }
  const store = { json: async key => { const row = boxes[key.replace('boxscore-', '')]; return { game: { homeTeam: { players: [] }, awayTeam: { players: [row.player] } } } } }
  const report = {}
  const days = []
  for (const date of ['2026-02-06', '2026-02-07']) days.push(await assertTwoDay(c, date, report, plan, store, games(date).map(([id, row]) => ({ id, home: row.home, away: row.away })), { query, write }))
  assert.deepEqual(days.map(day => day.identities.map(row => [row.nbaId, row.points, row.started])), [[['1642383', 20.6, true]], [['1642383', 30.3, null], ['201935', 37.4, true]]])
  assert.deepEqual(report.nbaTrades.map(row => [row.nbaId, row.owner, row.to, row.afterGameCount]), [['1642383', 'b', 'MEM', 1], ['201935', 'a', 'CLE', 1]], 'Clayton is verified on 2026-02-06 although Harden, listed first, is not yet due')
  assert.deepEqual(c.nbaTradeSubjects.map(row => row.verified === true), [true, true, false], 'Tonje waits for his first BOS game')
  assert.deepEqual(writes, ['real-input-2026-02-06.json', 'real-input-2026-02-07.json'])
})
