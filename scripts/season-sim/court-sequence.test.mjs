import assert from 'node:assert/strict'
import test from 'node:test'
import { courtSequence } from './court-sequence.mjs'
import { courtTime } from './court.mjs'

const player = (personId, seconds, starter = '1') => ({ personId, starter, statistics: { minutes: `PT${seconds / 60}M00S` } })
function fixture() {
  const home = [player(1, 480), ...[2, 3, 4, 5].map(id => player(id, 720)), player(6, 240, '0')]
  const away = [7, 8, 9, 10, 11].map(id => player(id, 720))
  const event = (actionNumber, clock, personId, subType) => ({ actionNumber, period: 1, clock, personId, actionType: subType ? 'substitution' : 'period', subType, teamId: personId <= 6 ? 1 : 2 })
  return { box: { game: { gameId: 'source-conflict', homeTeam: { teamTricode: 'HOME', players: home }, awayTeam: { teamTricode: 'AWAY', players: away } } }, actions: [event(1, 'PT12M00S', 0), event(2, 'PT08M00S', 1, 'out'), event(3, 'PT08M00S', 6, 'in'), event(4, 'PT04M00S', 1, 'out'), event(5, 'PT04M00S', 6, 'in'), event(6, 'PT00M00S', 0)] }
}

test('conflicting substitution pairs require one unique repair supported by final minutes', () => {
  const { box, actions } = fixture()
  const repaired = courtSequence(box, actions)
  assert.deepEqual(repaired.removed, [2, 3])
  const result = courtTime(box, repaired.actions, repaired.actions)
  assert.equal(result.get(1).seconds, 480)
  assert.equal(result.get(6).seconds, 240)
})

test('conflicting substitutions fail when final minutes support no repair', () => {
  const { box, actions } = fixture()
  box.game.homeTeam.players[0].statistics.minutes = 'PT06M00S'
  assert.throws(() => courtSequence(box, actions), /unique.*repair/)
})

test('valid source actions stay unchanged', () => {
  const { box, actions } = fixture()
  const valid = actions.filter(action => ![2, 3].includes(action.actionNumber))
  assert.equal(courtSequence(box, valid).actions, valid)
})

test('a wrong substitution identity requires unique final-minute evidence', () => {
  const { box, actions } = fixture()
  box.game.homeTeam.players[0].statistics.minutes = 'PT04M00S'
  box.game.homeTeam.players[5].statistics.minutes = 'PT04M00S'
  box.game.homeTeam.players.push(player(12, 240, '0'))
  actions[4] = { ...actions[4], personId: 12 }
  const corrected = courtSequence(box, actions)
  assert.deepEqual(corrected.reassigned, [{ actionNumber: 4, original: 1, replacement: 6 }])
  const result = courtTime(box, corrected.actions, corrected.actions)
  assert.equal(result.get(6).seconds, 240)
})

test('rounding residue does not invent another overtime starter', () => {
  const { box } = fixture()
  box.game.homeTeam.players[0].statistics.minutes = 'PT17M00S'
  box.game.homeTeam.players[5].statistics.minutes = 'PT00M00.36S'
  for (const team of [box.game.homeTeam, box.game.awayTeam]) for (const p of team.players.filter(p => p.starter === '1')) p.statistics.minutes = 'PT17M00S'
  const actions = [{ actionNumber: 1, period: 1, clock: 'PT00M00S', actionType: 'period' }, ...[2,3,4,5].map((id,index) => ({ actionNumber: index+2, period: 5, clock: 'PT04M00S', actionType: 'rebound', personId: id })), ...[7,8,9,10,11].map((id,index) => ({ actionNumber: index+6, period: 5, clock: 'PT04M00S', actionType: 'rebound', personId: id }))]
  assert.equal(courtTime(box, actions, actions).get(1).oncourt, '1')
})

test('an impossible NBA minute total requires independent ESPN corroboration', () => {
  const { box, actions } = fixture()
  for (const team of [box.game.homeTeam, box.game.awayTeam]) for (const p of team.players) p.name = `Player ${p.personId}`
  box.game.homeTeam.players[0].statistics.minutes = 'PT04M00S'
  box.game.homeTeam.players[5].statistics.minutes = 'PT08M00S'
  box.game.homeTeam.players.push({ ...player(12, 240, '0'), name: 'Player 12' })
  actions[4] = { ...actions[4], personId: 12 }
  const summary = { boxscore: { players: [{ statistics: [{ names: ['MIN'], athletes: box.game.homeTeam.players.map(p => ({ athlete: { displayName: p.name }, stats: [p.personId === 6 ? '4' : String(Number(/^PT(\d+)/.exec(p.statistics.minutes)[1]))] })) }] }] } }
  assert.throws(() => courtSequence(box, actions), /unique.*repair/)
  const repaired = courtSequence(box, actions, summary)
  assert.deepEqual(repaired.reassigned, [{ actionNumber: 4, original: 1, replacement: 6 }])
  assert.equal(repaired.minuteEvidence[0].personId, 6)
})
