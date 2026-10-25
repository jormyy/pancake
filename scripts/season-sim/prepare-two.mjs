import assert from 'node:assert/strict'
import { readFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureStore } from './fixtures.mjs'
import { calendarOracle } from './calendar-oracle.mjs'
import { postponementTimeline } from './postponement-oracle.mjs'
import { regularGame, seasonProfile } from './season-model.mjs'
import { laneDirectory, miniRoot, sha256, writeJson } from './common.mjs'

export function tableRows(payload) {
  const set = payload.resultSets[0]
  return set.rowSet.map(values => Object.fromEntries(set.headers.map((header, i) => [header, values[i]])))
}

export async function prepareTwoInputs() {
  const destination = await laneDirectory(path.join(miniRoot, 't3-inputs/replay'))
  const sources = path.join(miniRoot, 't3-inputs/sources'), sourceStore = await fixtureStore(sources)
  const stores = [path.join(miniRoot, 't3-inputs/2025'), path.join(miniRoot, 'fixtures')]
  const manifest = new Map(), games = [], entries = [], seasons = [], artifacts = []
  for (const [index, directory] of stores.entries()) {
    // Each season's range comes from its raw NBA schedule: first to last regular-season game day.
    const raw = await sourceStore.json(`schedule-${2025 + index}-stats`), rows = raw.leagueSchedule.gameDates.flatMap(day => day.games)
    const dated = rows.map(row => ({ ...row, id: row.gameId, date: row.gameDateEst.slice(0, 10) })), profile = seasonProfile(2025 + index, dated)
    const input = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
    const selected = input.games.filter(game => game.id.startsWith(profile.prefix) && game.provenance !== 'SYNTHETIC')
    assert.equal(selected.length, profile.games, `Complete ${profile.label} real boxes are required`)
    assert.ok(selected.every(row=>row.status===3),'Every historical box is an official final')
    games.push(...selected)
    const schedule = JSON.parse(await readFile(path.join(directory, 'schedule.json'), 'utf8')).games
    entries.push(...schedule)
    const store = await fixtureStore(directory)
    for (const row of store.manifest.values()) {
      if (row.provenance !== 'REAL-RAW' || /^(boxscore|playbyplay)-/.test(row.key) && !row.key.includes(profile.prefix) || row.key.startsWith('next-')) continue
      await copyFile(path.join(directory, row.file), path.join(destination, row.file))
      manifest.set(row.key, row)
    }
    assert.equal(raw.leagueSchedule.seasonYear, profile.label)
    const calendar = calendarOracle(dated)
    assert.equal(calendar.regularGames, selected.length)
    assert.equal(calendar.opening, profile.start)
    assert.equal(calendar.end, profile.end)
    const cupFinals = rows.filter(row => row.gameId.startsWith('006'))
    assert.equal(cupFinals.length, 1, 'Each NBA Cup final is present and excluded')
    const countedCupGames = rows.filter(row => regularGame(row.gameId) && /cup|in-season/i.test(`${row.gameLabel} ${row.gameSubtype}`))
    assert.ok(countedCupGames.length > 0, 'NBA Cup group and knockout regular games count')
    seasons.push({ ...profile, calendar, scheduleKey: `schedule-${profile.year}-stats`, cupFinals: cupFinals.map(row => ({ id: row.gameId, date: row.gameDateEst, gameLabel: row.gameLabel, gameSubtype: row.gameSubtype })), countedCupGames: countedCupGames.length, playoffStart: calendar.weeks.length - 2 })
  }
  for (const row of sourceStore.manifest.values()) {
    await copyFile(path.join(sources, row.file), path.join(destination, row.file))
    manifest.set(row.key, row)
  }
  const rosterDirectory=path.join(miniRoot,'t3-inputs/rosters'), rosterStore=await fixtureStore(rosterDirectory)
  const rosterHistory=JSON.parse(await readFile(path.join(rosterDirectory,'roster-history.json'),'utf8'))
  for(const row of rosterStore.manifest.values()){
    await copyFile(path.join(rosterDirectory,row.file),path.join(destination,row.file))
    manifest.set(row.key,row)
  }
  await writeJson(path.join(destination,'roster-history.json'),rosterHistory)
  const press = (await sourceStore.bytes('wildfire-reschedule')).toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const changed = /Charlotte at L\.A\. Lakers\s+\w+\.\s+(\d+)\/(\d+)\s+\w+\.\s+(\d+)\/(\d+)/.exec(press)
  assert.ok(changed, 'Pinned NBA announcement must contain the original and new Charlotte-Lakers dates')
  const sas = (await sourceStore.bytes('sas-lal-reschedule')).toString()
  const sasDate = /Monday, (March) (\d+)/.exec(sas)
  assert.ok(sasDate && /previously postponed game between the Spurs/.test(sas))
  const confirmations = {
    [`2025-${changed[1].padStart(2,'0')}-${changed[2].padStart(2,'0')}:CHA:LAL`]: { date: `2025-${changed[3].padStart(2,'0')}-${changed[4].padStart(2,'0')}`, source: 'wildfire-reschedule',announcedDate:'2025-01-15' },
    '2025-01-11:SAS:LAL': { date: new Date(`${sasDate[1]} ${sasDate[2]}, 2025 12:00 GMT`).toISOString().slice(0,10), source: 'sas-lal-reschedule',announcedDate:'2025-02-28' },
  }
  const postponements = postponementTimeline(entries, games, confirmations)
  for (const [date, away, home] of [['2025-01-09','CHA','LAL'],['2025-01-11','SAS','LAL'],['2026-01-08','MIA','CHI'],['2026-01-24','GSW','MIN'],['2026-01-25','DEN','MEM'],['2026-01-25','DAL','MIL']]) assert.ok(postponements.timelines.some(row => row.originalDate === date && row.away === away && row.home === home), `Required real postponement ${date} ${away}@${home}`)
  const rookies = tableRows(await sourceStore.json('draft-2025-stats')).map(row => ({ nbaId: String(row.PERSON_ID), name: row.PLAYER_NAME, pick: row.OVERALL_PICK }))
  assert.ok(rookies.length >= 58 && rookies.every(row => !row.name.startsWith('Synthetic Prospect')))
  const firstYears = {}
  for (const year of [2024, 2025]) for (const row of tableRows(await sourceStore.json(`player-index-${year}`))) if (row.FROM_YEAR != null) firstYears[String(row.PERSON_ID)] = Number(row.FROM_YEAR)
  for (const row of rookies) firstYears[row.nbaId] = 2025
  const secondStore=await fixtureStore(stores[1])
  for(const rookie of rookies)rookie.gameIds=[]
  for(const game of games.filter(row=>row.id.startsWith(seasons[1].prefix))){
    const box=await secondStore.json(`boxscore-${game.id}`)
    for(const player of [...box.game.homeTeam.players,...box.game.awayTeam.players]){
      const rookie=rookies.find(row=>row.nbaId===String(player.personId))
      if(rookie)rookie.gameIds.push(game.id)
    }
  }
  const nbaTrades = []
  for (const subject of [{ year: 2025, nbaId: '203076', from: 'LAL', to: 'DAL' }, { year: 2026, nbaId: '201935', from: 'LAC', to: 'CLE' }]) {
    const directory = stores[subject.year - 2025], store = await fixtureStore(directory), appearances = []
    for (const game of games.filter(row => row.id.startsWith(seasonProfile(subject.year).prefix) && [row.home,row.away].some(team => [subject.from,subject.to].includes(team)))) {
      const box = await store.json(`boxscore-${game.id}`)
      for (const team of [box.game.homeTeam,box.game.awayTeam]) if (team.players.some(player => String(player.personId) === subject.nbaId && player.played === '1')) appearances.push({ date: game.date, team: team.teamTricode })
    }
    const firstAfter = appearances.filter(row => row.team === subject.to).map(row => row.date).sort()[0]
    assert.ok(firstAfter && appearances.some(row => row.team === subject.from && row.date < firstAfter), 'NBA deadline subject appears for both teams in raw boxes')
    nbaTrades.push({ ...subject, firstAfter, source: `nba-trade-${subject.year}`, provenance: 'REAL-DERIVED from raw NBA boxes and official announcement' })
  }
  const plan = { provenance: 'REAL-DERIVED', mode: 'two-real-seasons', seasons, nbaTrades, draft: { year: 2025, availableAt: '2025-06-28T00:00:00Z', availabilityProvenance: 'SYNTHETIC conservative full-board availability after both NBA draft rounds; source update instant not reconstructed', rookies }, firstYears, postponements, gaps: ['Original NBA schedule archive snapshots are unavailable; original NBA game IDs use unique ESPN team/date correlation.', 'Postponement and schedule-release availability instants are replay policies, not measured provider timestamps.', 'Rankings/projection input quality and complete career totals remain unverified.'], sourceFailures: [...manifest.values()].filter(row => row.status !== 200) }
  for (const [file, value] of [['games.json', { provenance: 'REAL-DERIVED', games }], ['schedule.json', { provenance: 'REAL-DERIVED', games: entries }], ['two-season-plan.json', plan],['roster-history.json',rosterHistory]]) {
    await writeJson(path.join(destination, file), value)
    const bytes = await readFile(path.join(destination, file))
    artifacts.push({ file, bytes: bytes.length, sha256: sha256(bytes), provenance: file==='two-season-plan.json'?'REAL-DERIVED facts; SYNTHETIC publication timing':'REAL-DERIVED', sourceKeys: [...manifest.keys()] })
  }
  await writeJson(path.join(destination, 'derived-manifest.json'), { artifacts })
  await readFile(path.join(destination, 'games.json'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(destination, 'manifest.jsonl'), [...manifest.values()].map(row => JSON.stringify(row)).join('\n') + '\n')
  return { destination, games: games.length, rawSources: manifest.size, seasons: seasons.map(({ year, start, end, calendar, cupFinals, countedCupGames }) => ({ year, start, end, dates: (Date.parse(end) - Date.parse(start)) / 86400000 + 1, calendar, cupFinals, countedCupGames })), postponements: postponements.timelines, gaps: plan.gaps, failures: plan.sourceFailures, artifacts }
}
