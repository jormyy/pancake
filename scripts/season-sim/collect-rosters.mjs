import assert from 'node:assert/strict'
import path from 'node:path'
import { fixtureStore } from './fixtures.mjs'
import { inputSource } from './input-source.mjs'
import { dates, etDate, laneDirectory, miniRoot, teamCode, writeJson } from './common.mjs'

export function preseasonGames(payload) {
  return payload.leagueSchedule.gameDates.flatMap(day => day.games).filter(row => row.gameId.startsWith('001')).map(row => ({ id: row.gameId,date: row.gameDateEst.slice(0,10),time: row.gameDateTimeUTC,home:row.homeTeam.teamTricode,away:row.awayTeam.teamTricode,rosterOnly:true }))
}

export async function collectRosterHistory() {
  const sources = await fixtureStore(path.join(miniRoot,'t3-inputs/sources'))
  const directory = await laneDirectory(path.join(miniRoot,'t3-inputs/rosters')), source = await inputSource(directory)
  const games = [], failures = []
  for (const year of [2025,2026]) {
    const selected = preseasonGames(await sources.json(`schedule-${year}-stats`))
    const events = []
    for (const day of dates(selected.map(row=>row.date).sort()[0],selected.map(row=>row.date).sort().at(-1))) {
      const {bytes,row} = await source(`preseason-board-${day}`,`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-','')}&limit=1000`,'espn-preseason-scoreboard')
      if(row.status!==200){failures.push(row);continue}
      events.push(...(JSON.parse(bytes.toString()).events??[]))
    }
    for (const game of selected) {
      const {row} = await source(`roster-boxscore-${game.id}`,`https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${game.id}.json`,'nba-preseason-roster-box')
      if(row.status!==200){failures.push(row);continue}
      const event = events.find(event=>{
        const teams=event.competitions?.[0]?.competitors??[]
        return etDate(event.date)===game.date && teams.some(row=>row.homeAway==='home' && teamCode(row.team.abbreviation)===game.home) && teams.some(row=>row.homeAway==='away' && teamCode(row.team.abbreviation)===game.away)
      })
      if(!event){failures.push({game,reason:'No matching raw ESPN preseason event'});continue}
      const summary=await source(`roster-summary-${event.id}`,`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${event.id}`,'espn-preseason-roster-summary')
      if(summary.row.status!==200){failures.push(summary.row);continue}
      games.push({...game,espnId:event.id})
      console.log(JSON.stringify({rosterGame:game.id,espnId:event.id}))
    }
  }
  assert.ok(games.length>0,'Historical preseason observations must exist')
  const result={provenance:'REAL-DERIVED',purpose:'Only dated preseason roster observations; exhibitions never enter scoring games or fantasy calendars',games,failures}
  await writeJson(path.join(directory,'roster-history.json'),result)
  return result
}
