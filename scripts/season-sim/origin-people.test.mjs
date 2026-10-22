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

// REAL-RAW slice of the pinned replay inputs: De'Anthony Melton (1629001) last dressed for GSW on 2024-11-12. GSW traded him
// to BKN on 2024-12-15, and BKN's box 0022401224 (2024-12-16 vs CLE) lists him INACTIVE_TRADE; he never dressed again that
// season, so no ESPN summary line ever moves him. Mark Williams (1631109): LAL's box 0022400742 (2025-02-08 vs IND) lists him
// INACTIVE_TRADE, the trade was rescinded and CHA's box 0022400752 (2025-02-09 at DET) lists him again (subset shown).
const boxTransfers = originPeople.boxTransfers ?? (() => [])
const listed = rows => rows.map(([personId, status, notPlayingReason]) => ({ personId, status, notPlayingReason }))
const bknCle = { id: '0022401224', date: '2024-12-16', time: '2024-12-17T00:30:00Z', home: 'BKN', away: 'CLE' }
const bknCleBox = { game: { homeTeam: { players: listed([[1629661, 'ACTIVE', null], [1627827, 'ACTIVE', null], [1629651, 'ACTIVE', null], [1630553, 'ACTIVE', null], [1627732, 'ACTIVE', null], [1630592, 'ACTIVE', null], [1629003, 'ACTIVE', null], [1630570, 'ACTIVE', null], [1630549, 'ACTIVE', null], [1641730, 'ACTIVE', null], [1631213, 'ACTIVE', null], [1630533, 'ACTIVE', 'DND_INJURY'], [1641736, 'INACTIVE', 'INACTIVE_TRADE'], [202711, 'INACTIVE', 'INACTIVE_INJURY'], [1641798, 'INACTIVE', 'INACTIVE_GLEAGUE_TWOWAY'], [1629001, 'INACTIVE', 'INACTIVE_TRADE'], [1630560, 'INACTIVE', 'INACTIVE_INJURY'], [1641727, 'INACTIVE', 'INACTIVE_GLEAGUE_ON_ASSIGNMENT']]) }, awayTeam: { players: listed([[1630171, 'ACTIVE', null], [1630596, 'ACTIVE', 'DNP_INJURY'], [1628386, 'ACTIVE', null], [1628378, 'ACTIVE', null], [1629636, 'ACTIVE', null], [1627747, 'ACTIVE', null], [1627777, 'ACTIVE', null], [1630241, 'ACTIVE', null], [1629731, 'ACTIVE', null], [1629660, 'ACTIVE', null], [202684, 'ACTIVE', null], [1630550, 'ACTIVE', null], [1641734, 'INACTIVE', 'INACTIVE_GLEAGUE_TWOWAY'], [1641854, 'INACTIVE', 'INACTIVE_INJURY'], [1629622, 'INACTIVE', 'INACTIVE_INJURY'], [1631247, 'INACTIVE', 'INACTIVE_GLEAGUE_TWOWAY'], [1642281, 'INACTIVE', 'INACTIVE_INJURY']]) } } }
const lalInd = { id: '0022400742', date: '2025-02-08', time: '2025-02-08T21:00:00Z', home: 'LAL', away: 'IND' }
const lalIndBox = { game: { homeTeam: { players: listed([[1627827, 'ACTIVE', null], [1629060, 'ACTIVE', null], [1629637, 'ACTIVE', null], [1629216, 'ACTIVE', null], [1630559, 'ACTIVE', null], [1629020, 'ACTIVE', null], [1629003, 'ACTIVE', null], [1641998, 'ACTIVE', null], [1630692, 'ACTIVE', null], [202693, 'ACTIVE', null], [1631132, 'ACTIVE', null], [1626174, 'ACTIVE', 'DND_INJURY'], [1629029, 'INACTIVE', 'INACTIVE_INJURY'], [1642355, 'INACTIVE', 'INACTIVE_GLEAGUE_ON_ASSIGNMENT'], [2544, 'INACTIVE', 'INACTIVE_INJURY'], [1628467, 'INACTIVE', 'INACTIVE_INJURY'], [1631109, 'INACTIVE', 'INACTIVE_TRADE']]) }, awayTeam: { players: listed([[1631097, 'ACTIVE', null], [1627783, 'ACTIVE', null], [1628418, 'ACTIVE', null], [1629614, 'ACTIVE', null], [1630169, 'ACTIVE', null], [1630167, 'ACTIVE', null], [204456, 'ACTIVE', null], [1630174, 'ACTIVE', null], [1641767, 'ACTIVE', null], [1641716, 'ACTIVE', null], [1642402, 'ACTIVE', null], [1642277, 'ACTIVE', null], [1631245, 'ACTIVE', null], [201949, 'ACTIVE', null], [1642484, 'INACTIVE', 'INACTIVE_GLEAGUE_TWOWAY'], [1630543, 'INACTIVE', 'INACTIVE_INJURY'], [1626167, 'INACTIVE', 'INACTIVE_INJURY']]) } } }
const detCha = { id: '0022400752', date: '2025-02-09', time: '2025-02-09T18:00:00Z', home: 'DET', away: 'CHA' }
const detChaBox = { game: { homeTeam: { players: [] }, awayTeam: { players: listed([[1631109, 'INACTIVE', 'INACTIVE_NOT_WITH_TEAM']]) } } }
const melton = () => ({ id: '4066436', nbaId: 1629001, firstName: "De'Anthony", lastName: 'Melton', fullName: "De'Anthony Melton", fromYear: 2018, observations: [{ time: '2024-11-11T00:00:00Z', date: '2024-11-10', team: 'GSW', position: 'G', yearsExp: null, rosterOnly: false }, { time: '2024-11-13T03:00:00Z', date: '2024-11-12', team: 'GSW', position: 'G', yearsExp: null, rosterOnly: false }] })
const williams = () => ({ id: '4701232', nbaId: 1631109, firstName: 'Mark', lastName: 'Williams', fullName: 'Mark Williams', fromYear: 2022, observations: ['2025-02-01', '2025-02-03', '2025-02-05'].map(date => ({ time: `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')}T00:00:00Z`, date, team: 'CHA', position: 'C', yearsExp: null, rosterOnly: false })) })
const feeds = (all, date) => { const row = rosterForDate(all, date).find(player => player.nbaId === 1629001); return row && { espnRoster: [row.team, row.status.type], index: playerIndexAt(all, date).resultSets[0].rowSet.find(player => player[0] === 1629001)[3], historicalRoster: { espnId: row.id, nbaTeam: row.team } } }

test('a real box listing a known player for another team moves him on every feed from that box date',()=>{
  const people=new Map([['4066436',melton()]])
  assert.deepEqual(boxTransfers(people,bknCle,bknCleBox),[{nbaId:1629001,espnId:'4066436',from:'GSW',to:'BKN',date:'2024-12-16',gameId:'0022401224',reason:'INACTIVE_TRADE'}])
  const all=[...people.values()]
  assert.deepEqual(feeds(all,'2024-12-15'),{espnRoster:['GSW','active'],index:1,historicalRoster:{espnId:'4066436',nbaTeam:'GSW'}},'Nothing moves before the box date')
  assert.deepEqual(feeds(all,'2024-12-16'),{espnRoster:['BKN','active'],index:1,historicalRoster:{espnId:'4066436',nbaTeam:'BKN'}})
  assert.deepEqual(feeds(all,'2025-04-13'),{espnRoster:['BKN','active'],index:1,historicalRoster:{espnId:'4066436',nbaTeam:'BKN'}},'The GSW phantom is not served for the rest of the season')
  assert.deepEqual(rosterForDate(all,'2024-12-16')[0].position,{abbreviation:'G'},'The moved player keeps his last dated position')
})

test('a box never introduces a person and repeats nothing for his current team',()=>{
  const people=new Map([['4066436',melton()]])
  boxTransfers(people,bknCle,bknCleBox)
  assert.equal(people.size,1,'Unknown box persons (CLE and BKN two-ways never seen in a summary) stay unknown')
  assert.deepEqual(boxTransfers(people,{...bknCle,id:'0022400364',date:'2024-12-19',time:'2024-12-20T00:30:00Z',home:'TOR',away:'BKN'},{game:{homeTeam:{players:[]},awayTeam:bknCleBox.game.homeTeam}}),[],'A later BKN listing adds no observation')
  assert.equal(people.get('4066436').observations.length,3)
  const later={...melton(),observations:[...melton().observations,{time:'2024-12-20T00:30:00Z',date:'2024-12-19',team:'BKN',position:'G',yearsExp:null,rosterOnly:false}]}
  assert.deepEqual(boxTransfers(new Map([['4066436',later]]),bknCle,bknCleBox).map(row=>[row.from,row.to,row.date]),[['GSW','BKN','2024-12-16']],'A box read out of order compares only observations dated before it')
})

test('synthetic and preseason boxes move nobody',()=>{
  for(const game of [{...bknCle,provenance:'SYNTHETIC'},{...bknCle,rosterOnly:true}]){
    const people=new Map([['4066436',melton()]])
    assert.deepEqual(boxTransfers(people,game,bknCleBox),[])
    assert.equal(feeds([...people.values()],'2024-12-16').espnRoster[0],'GSW')
  }
})

test('a rescinded trade follows each dated box out and back',()=>{
  const people=new Map([['4701232',williams()]])
  assert.deepEqual(boxTransfers(people,lalInd,lalIndBox).map(row=>[row.from,row.to,row.date]),[['CHA','LAL','2025-02-08']])
  assert.deepEqual(boxTransfers(people,detCha,detChaBox).map(row=>[row.from,row.to,row.date]),[['LAL','CHA','2025-02-09']])
  const all=[...people.values()]
  assert.deepEqual(['2025-02-07','2025-02-08','2025-02-09'].map(date=>rosterForDate(all,date)[0].team),['CHA','LAL','CHA'])
})
