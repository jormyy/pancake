import assert from 'node:assert/strict'
import test from 'node:test'
import { rosterForDate, playerIndexAt } from './origin-people.mjs'
import * as originPeople from './origin-people.mjs'

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

// REAL-RAW slice of the sim-t12 fixtures: Keita Bates-Diop (1628966) played five MIN preseason games, and MIN's
// opening-night box 0022400062 (2024-10-22 at LAL) lists 18 MIN players, 3 of them inactive, but not him.
const minOpening = [1630183, 203944, 203497, 1630162, 201144, 1628978, 1629675, 1629638, 204060, 1642265, 1628408, 1630568, 1631159, 1631169, 1630545, 1641740, 1642399, 1630227]
const openings = new Map([[2024, { date: '2024-10-22', teams: new Map([['MIN', { gameId: '0022400062', date: '2024-10-22', people: new Set(minOpening) }]]) }]])
const camp = (nbaId, firstName, lastName, fromYear, dates) => ({ id: `espn-${nbaId}`, nbaId, firstName, lastName, fullName: `${firstName} ${lastName}`, fromYear, observations: dates.map(date => ({ date, team: 'MIN', position: 'F', rosterOnly: true })) })
const batesDiop = camp(1628966, 'Keita', 'Bates-Diop', 2018, ['2024-10-04', '2024-10-11', '2024-10-13', '2024-10-16', '2024-10-17'])
const clark = camp(1641740, 'Jaylen', 'Clark', 2023, ['2024-10-04', '2024-10-17'])

test('a camp player missing from his team opening-night box is served on no feed from the opener on',()=>{
  assert.deepEqual(rosterForDate([batesDiop,clark],'2024-10-21',openings).map(row=>[row.nbaId,row.team,row.status.type]),[[1628966,'MIN','active'],[1641740,'MIN','active']])
  assert.deepEqual(rosterForDate([batesDiop,clark],'2024-10-22',openings).map(row=>[row.nbaId,row.team,row.status.type]),[[1641740,'MIN','active']])
  assert.deepEqual(playerIndexAt([batesDiop,clark],'2024-10-22',openings).resultSets[0].rowSet.map(row=>[row[0],row[3]]),[[1641740,1]])
  assert.deepEqual(rosterForDate([batesDiop],'2024-11-04',openings),[])
  assert.deepEqual(rosterForDate([batesDiop],'2025-08-01',openings),[],'The cut is not served as an inactive MIN player next summer')
  const signed={...batesDiop,observations:[...batesDiop.observations,{date:'2025-01-10',team:'NYK',position:'F'}]}
  assert.deepEqual(rosterForDate([signed],'2025-01-10',openings).map(row=>[row.team,row.status.type]),[['NYK','active']])
  assert.deepEqual(rosterForDate([batesDiop],'2024-10-22'),rosterForDate([batesDiop],'2024-10-21'),'Without opening rosters the dated camp evidence is unchanged')
})

test('opening rosters come from each team first real box of the season',()=>{
  const box=(home,away)=>({game:{homeTeam:{players:home.map(personId=>({personId}))},awayTeam:{players:away.map(personId=>({personId}))}}})
  const games=[
    {id:'0012400072',date:'2024-10-17',time:'2024-10-18T00:00:00Z',home:'MIN',away:'CHI',rosterOnly:true},
    {id:'0022400078',date:'2024-10-24',time:'2024-10-24T23:00:00Z',home:'MIN',away:'SAC'},
    {id:'0022400062',date:'2024-10-22',time:'2024-10-23T02:00:00Z',home:'LAL',away:'MIN'},
    {id:'0022500001',date:'2025-10-21',time:'2025-10-21T23:30:00Z',home:'OKC',away:'MIN',provenance:'SYNTHETIC'},
  ]
  const boxes={'0022400078':box([1630162,1628966],[1628368]),'0022400062':box([2544],[1630162]),'0022500001':box([1628983],[1628966])}
  const built=originPeople.openingRosters(games,game=>boxes[game.id])
  assert.deepEqual([...built.keys()],[2024,2025])
  assert.equal(built.get(2024).date,'2024-10-22')
  assert.deepEqual({...built.get(2024).teams.get('MIN'),people:[...built.get(2024).teams.get('MIN').people]},{gameId:'0022400062',date:'2024-10-22',people:[1630162]})
  assert.equal(built.get(2024).teams.get('SAC').gameId,'0022400078')
  assert.equal(built.get(2025).teams.get('MIN').people,null)
  const returning={...batesDiop,observations:[{date:'2025-10-10',team:'MIN',position:'F',rosterOnly:true}]}
  assert.equal(rosterForDate([returning],'2025-10-22',built).length,1,'A synthetic first box cannot remove a camp player')
  assert.deepEqual(rosterForDate([batesDiop],'2024-10-22',built),[])
})

test('an earlier season holds after the next opener only for players that team still lists',()=>{
  const returning=(nbaId,team)=>({id:`espn-${nbaId}`,nbaId,firstName:'Real',lastName:`Veteran ${nbaId}`,fromYear:2015,observations:[{date:'2024-03-01',team,position:'G'}]})
  const later=new Map([[2024,{date:'2024-10-22',teams:new Map([['MIN',{gameId:'0022400062',date:'2024-10-22',people:new Set([1630162])}],['NYK',{gameId:'0022400061',date:'2024-10-22',people:new Set()}]])}]])
  assert.deepEqual(rosterForDate([returning(1630162,'MIN'),returning(1626166,'NYK')],'2024-10-21',later).map(row=>[row.nbaId,row.team,row.status.type]),[[1630162,'MIN','inactive'],[1626166,'NYK','inactive']])
  assert.deepEqual(rosterForDate([returning(1630162,'MIN'),returning(1626166,'NYK')],'2024-10-22',later).map(row=>[row.nbaId,row.team]),[[1630162,'MIN']])
  const traded={...returning(1626166,'NYK'),observations:[{date:'2024-10-04',team:'NYK',position:'G',rosterOnly:true},{date:'2024-10-15',team:'MIN',position:'G',rosterOnly:true}]}
  const both=new Map([[2024,{date:'2024-10-22',teams:new Map([['MIN',{gameId:'0022400062',date:'2024-10-22',people:new Set([1626166])}],['NYK',{gameId:'0022400061',date:'2024-10-22',people:new Set()}]])}]])
  assert.deepEqual(rosterForDate([traded],'2024-10-22',both).map(row=>[row.team,row.status.type]),[['MIN','active']],'A preseason trade keeps the team whose opening box lists him')
})

test('the roster source audit names each superseded observation and the opening box that omits him',()=>{
  const veteran={...clark,id:'espn-1626166',nbaId:1626166,firstName:'Cameron',lastName:'Payne',fullName:'Cameron Payne',fromYear:2015,observations:[{date:'2024-10-11',team:'MIN',position:'G',rosterOnly:true},{date:'2024-10-22',team:'MIN',position:'G'}]}
  const alias={...batesDiop,id:'summary-alias',observations:[{date:'2024-10-16',team:'MIN',position:'F',rosterOnly:true}]}
  const audit=originPeople.rosterSourceAudit([batesDiop,alias,clark,veteran],'2024-10-22',openings)
  assert.equal(audit.served,2)
  assert.deepEqual(audit.unserved,[{nbaId:1628966,name:'Keita Bates-Diop',fromYear:2018,reason:'Dated roster observations superseded by opening-night boxes that do not list him'}])
  assert.deepEqual(audit.superseded.map(row=>[row.nbaId,row.observations.length,row.observations[0],row.servedAs]),[[1628966,6,{team:'MIN',date:'2024-10-04',camp:true,openingBox:'0022400062'},null],[1626166,1,{team:'MIN',date:'2024-10-11',camp:true,openingBox:'0022400062'},'MIN']])
  assert.deepEqual(audit.openingRosters,[{year:2024,date:'2024-10-22',teams:1,unproven:[]}])
  assert.deepEqual(originPeople.rosterSourceAudit([batesDiop],'2024-10-21',openings).superseded,[])
})
