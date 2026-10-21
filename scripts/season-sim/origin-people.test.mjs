import assert from 'node:assert/strict'
import test from 'node:test'
import { rosterForDate, playerIndexAt } from './origin-people.mjs'

const people = [{ id: 'espn', nbaId: 1, firstName: 'Real', lastName: 'Rookie', fromYear: 2025, observations: [{ date: '2025-10-21', team: 'DAL', position: 'SF' }, { date: '2026-02-06', team: 'LAL', position: 'SF' }] }]

test('historical roster does not expose a future player before first observation', () => {
  assert.deepEqual(rosterForDate(people, '2024-10-22'), [])
  assert.equal(rosterForDate(people, '2025-10-21')[0].team, 'DAL')
  assert.equal(rosterForDate(people, '2026-02-06')[0].team, 'LAL')
})

test('the NBA index cannot mark future players active', () => {
  assert.equal(playerIndexAt(people, '2024-10-22').resultSets[0].rowSet.length, 0)
  assert.equal(playerIndexAt(people, '2025-10-21').resultSets[0].rowSet[0][3], 1)
  assert.equal(playerIndexAt(people, '2026-10-21').resultSets[0].rowSet[0][3], 0)
})

test('roster experience follows the historical season rather than the retrieval year', () => {
  assert.deepEqual(rosterForDate(people, '2025-10-21')[0].experience, { years: 0 })
  assert.deepEqual(rosterForDate(people, '2026-10-21')[0].experience, { years: 1 })
})

test('dated preseason observations supply veterans without exposing future rookies',()=>{
  const veteran={...people[0],fromYear:2010,observations:[{date:'2024-10-04',team:'BOS',position:'C'}]}
  const roster=rosterForDate([veteran,...people],'2024-10-22')
  assert.equal(roster.length,1)
  assert.equal(roster[0].experience.years,14)
})

test('summary aliases cannot create two roster or index rows for one NBA person',()=>{
  const alias={...people[0],id:'summary-alias',observations:[{date:'2025-10-22',team:'DAL',position:'SF'}]}
  assert.equal(rosterForDate([people[0],alias],'2025-10-23').length,1)
  assert.equal(playerIndexAt([people[0],alias],'2025-10-23').resultSets[0].rowSet.length,1)
  assert.equal(rosterForDate([people[0],alias],'2025-10-23')[0].id,'espn')
  const later={...alias,observations:[{date:'2026-02-07',team:'NYK',position:'SF'}]}
  assert.equal(rosterForDate([people[0],later],'2026-02-08')[0].team,'NYK')
  assert.ok(rosterForDate(people,'2025-10-21')[0].observations.every(row=>row.date<='2025-10-21'))
})

test('camp-only names without a historical NBA career cannot become NBA roster records',()=>{
  const camp={...people[0],fromYear:null,observations:[{date:'2024-10-04',team:'DEN',position:'F',rosterOnly:true}]}
  assert.deepEqual(rosterForDate([camp],'2024-10-22'),[])
  assert.equal(rosterForDate([{...camp,fromYear:2022}],'2024-10-22').length,1)
  assert.deepEqual(rosterForDate([{...camp,fromYear:2025}],'2024-10-22'),[])
})
