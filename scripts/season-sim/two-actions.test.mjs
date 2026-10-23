import assert from 'node:assert/strict'
import test from 'node:test'
import { intendedOwner, nbaTradeSetup, rookieListings, rookieMoves, rookieStarters } from './two-actions.mjs'

test('rookie owner oracle follows intended trade, drop, and successful waiver actions only', () => {
  const c = { draftedRookies: [{ playerId: 'p', owner: 'a' }], identityMoves: [{ playerId: 'p', owner: 'b', at: 10 }, { playerId: 'p', owner: null, at: 20 }], waiverScenarios: [{ targets: [], input: { claims: [{ id: 'claim', player: 'p', member: 'c' }] }, expected: { claims: { claim: 'succeeded' } }, processAt: 30 }] }
  assert.equal(intendedOwner(c,'p',0),'a')
  assert.equal(intendedOwner(c,'p',15),'b')
  assert.equal(intendedOwner(c,'p',25),null)
  assert.equal(intendedOwner(c,'p',35),'c')
})

// REAL-RAW slices of the pinned replay inputs (manifest.jsonl de4ce76f, boxscore-<gameId>): every box listing of the draftee in
// the window, as [gameId, date, tip-off, box side, played].
const listingsOf = (nbaId, rows) => rows.map(([gameId, date, time, team, played]) => ({ nbaId, gameId, date, time, team, played }))
const clayton = listingsOf('1642383', [['0022500706', '2026-02-01', '2026-02-01T23:00:00Z', 'UTA', '1'], ['0022500717', '2026-02-03', '2026-02-04T00:00:00Z', 'UTA', '0'], ['0022500731', '2026-02-04', '2026-02-05T03:00:00Z', 'MEM', '0'], ['0022500745', '2026-02-06', '2026-02-07T03:00:00Z', 'MEM', '1'], ['0022500755', '2026-02-07', '2026-02-08T03:00:00Z', 'MEM', '1']])
const tonje = listingsOf('1642910', [['0022500706', '2026-02-01', '2026-02-01T23:00:00Z', 'UTA', '0'], ['0022500717', '2026-02-03', '2026-02-04T00:00:00Z', 'UTA', '0'], ['0022500741', '2026-02-06', '2026-02-07T00:30:00Z', 'BOS', '0'], ['0022500757', '2026-02-08', '2026-02-08T17:30:00Z', 'BOS', '0'], ['0022500778', '2026-02-11', '2026-02-12T00:30:00Z', 'BOS', '0'], ['0022500799', '2026-02-19', '2026-02-20T03:00:00Z', 'BOS', '0'], ['0022500823', '2026-02-22', '2026-02-22T23:30:00Z', 'BOS', '0'], ['0022500839', '2026-02-24', '2026-02-25T02:00:00Z', 'BOS', '1']])
const flagg = listingsOf('1642843', [['0022500701', '2026-01-31', '2026-02-01T01:30:00Z', 'DAL', '1'], ['0022500721', '2026-02-03', '2026-02-04T01:00:00Z', 'DAL', '1'], ['0022500738', '2026-02-05', '2026-02-06T01:30:00Z', 'DAL', '1']])
const draftees = [{ nbaId: '1642843', name: 'Cooper Flagg' }, { nbaId: '1642383', name: 'Walter Clayton Jr.' }, { nbaId: '1642910', name: 'John Tonje' }]

test('a real draftee listed for a second team midseason is an NBA move from that box to his first game for the new team', () => {
  const moves = rookieMoves(draftees, [...tonje, ...flagg, ...clayton].reverse(), 2026)
  assert.deepEqual(moves.map(({ nbaId, from, to, movedOn, firstAfter, source }) => ({ nbaId, from, to, movedOn, firstAfter, source })), [
    { nbaId: '1642383', from: 'UTA', to: 'MEM', movedOn: '2026-02-04', firstAfter: '2026-02-06', source: 'boxscore-0022500731' },
    { nbaId: '1642910', from: 'UTA', to: 'BOS', movedOn: '2026-02-06', firstAfter: '2026-02-24', source: 'boxscore-0022500741' },
  ])
  assert.ok(moves.every(row => row.year === 2026))
  assert.deepEqual(rookieMoves(draftees, [...flagg, ...tonje.slice(0, -1)], 2026), [], 'One team, or no game played for the new team, is not a move')
  const back = [...tonje.slice(0, -1), { ...tonje.at(-1), team: 'UTA' }]
  assert.deepEqual(rookieMoves(draftees, back, 2026), [], 'A game played after returning to the old team is not a game for the new team')
})

test('draftee listings take the box side that lists him, inactive listings included, from his listed games only', async () => {
  const side = (code, ids) => ({ teamTricode: code, players: ids.map(([personId, played]) => ({ personId, played })) })
  const boxes = { g1: { game: { homeTeam: side('UTA', [[1642383, '0'], [1, '1']]), awayTeam: side('MEM', [[2, '1']]) } }, g2: { game: { homeTeam: side('MEM', [[1642383, '1']]), awayTeam: side('DAL', []) } } }
  const read = []
  const listings = await rookieListings([{ nbaId: '1642383', gameIds: ['g1', 'g2'] }], [{ id: 'g1', date: '2026-02-03', time: 't1', home: 'UTA', away: 'MEM' }, { id: 'g2', date: '2026-02-06', time: 't2', home: 'MEM', away: 'DAL' }, { id: 'g3', date: '2026-02-07', time: 't3', home: 'X', away: 'Y' }], id => { read.push(id); return boxes[id] })
  assert.deepEqual(read, ['g1', 'g2'])
  assert.deepEqual(listings, [{ nbaId: '1642383', gameId: 'g1', date: '2026-02-03', time: 't1', team: 'UTA', played: '0' }, { nbaId: '1642383', gameId: 'g2', date: '2026-02-06', time: 't2', team: 'MEM', played: '1' }])
})

test('every raw-box NBA move of the season gets a fantasy owner on January 1, one subject per member, never from a drafted rookie', async () => {
  const roster = [], players = new Map([['201935', 'harden'], ['1642383', 'clayton'], ['1642910', 'tonje']]), calls = []
  for (const member of ['a', 'b', 'c', 'd']) for (const kind of ['r1', 'r2', 'v1', 'v2']) roster.push({ id: `${member}-${kind}`, player_id: `${member}-${kind}`, member_id: member })
  const c = {
    seasonYear: 2026, leagueId: 'L', leagueSeasonId: 'S', users: ['a', 'b', 'c', 'd'].map(memberId => ({ memberId })),
    draftedRookies: roster.filter(row => row.id.includes('-r')).map(row => ({ playerId: row.player_id, owner: row.member_id })),
    rest: async (_user, query) => query.startsWith('players?') ? [{ id: players.get(/nba_id=eq\.(\d+)/.exec(query)[1]), nba_id: /nba_id=eq\.(\d+)/.exec(query)[1] }] : roster.map(row => ({ ...row })),
    rpc: async (user, name, args) => {
      calls.push([name, user.memberId, args.p_roster_player_id ?? args.p_player_id])
      if (name === 'drop_player_atomic') roster.splice(roster.findIndex(row => row.id === args.p_roster_player_id), 1)
      else roster.push({ id: `${args.p_member_id}-${args.p_player_id}`, player_id: args.p_player_id, member_id: args.p_member_id })
    },
  }
  const plan = { nbaTrades: [{ year: 2025, nbaId: '203076', from: 'LAL', to: 'DAL', firstAfter: '2025-02-08' }, { year: 2026, nbaId: '201935', from: 'LAC', to: 'CLE', firstAfter: '2026-02-08' }] }
  // The two moves rookieMoves derives from the full pinned 2025-26 boxes (W/evidence/post/t20/rookie-moves.json).
  const moves = [{ year: 2026, nbaId: '1642383', from: 'UTA', to: 'MEM', movedOn: '2026-02-04', firstAfter: '2026-02-06' }, { year: 2026, nbaId: '1642910', from: 'UTA', to: 'BOS', movedOn: '2026-02-06', firstAfter: '2026-02-24' }]
  await nbaTradeSetup(c, '2026-01-02', plan, moves)
  assert.equal(c.nbaTradeSubjects, undefined)
  await nbaTradeSetup(c, '2026-01-01', plan, moves)
  assert.deepEqual(c.nbaTradeSubjects.map(row => [row.nbaId, row.playerId, row.owner, row.to, row.firstAfter]), [['201935', 'harden', 'a', 'CLE', '2026-02-08'], ['1642383', 'clayton', 'b', 'MEM', '2026-02-06'], ['1642910', 'tonje', 'c', 'BOS', '2026-02-24']])
  assert.ok(calls.filter(([name]) => name === 'drop_player_atomic').every(([, , id]) => id.endsWith('-v1')), 'Only veterans make room')
})

test('an NBA-moved subject due for its first new-team start starts ahead of its owner\'s listed rookies', () => {
  const row = (player_id, nba_id = 1) => ({ player_id, players: { nba_id } })
  const r1 = row('r1'), r2 = row('r2'), subject = row('clayton'), veteran = row('v1'), active = [r1, r2, veteran, subject]
  assert.deepEqual(rookieStarters([r1, r2, subject], active, null, ['clayton']), [subject, r1])
  assert.deepEqual(rookieStarters([r1, r2, subject], active, null, []), [r1, r2], 'Before it is due the listing order holds')
  assert.deepEqual(rookieStarters([r1, subject], active, 'r1', []), [subject, r2], 'The measured bench rookie sits')
})
