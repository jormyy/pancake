import path from 'node:path'
import { laneDirectory, miniRoot, writeJson } from './common.mjs'
import { inputSource } from './input-source.mjs'

export function sourceProblems(rows){
  return {failedFetches:rows.filter(row=>row.status!==200),unavailableArchives:rows.filter(row=>row.kind==='archive-index'&&row.status===200&&row.bytes<=3)}
}

export async function collectTwoSources() {
  const directory = await laneDirectory(path.join(miniRoot, 't3-inputs/sources'))
  const source = await inputSource(directory)
  const requests = [
    ['schedule-2025-stats', 'https://stats.nba.com/stats/scheduleleaguev2?LeagueID=00&Season=2024-25', 'nba-schedule'],
    ['schedule-2026-stats', 'https://stats.nba.com/stats/scheduleleaguev2?LeagueID=00&Season=2025-26', 'nba-schedule'],
    ['schedule-2025-archive-cdn', 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_2024-25.json', 'nba-schedule'],
    ['schedule-wayback-index', 'https://web.archive.org/cdx/search/cdx?url=cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json&output=json&filter=statuscode:200&from=2024&to=2025&filter=mimetype:application/json&collapse=timestamp:6', 'archive-index'],
    ['draft-2025-news', 'https://www.nba.com/news/2025-nba-draft-order', 'nba-draft-html'],
    ['draft-2025-page', 'https://www.nba.com/draft/2025', 'nba-draft-html'],
    ['draft-2025-stats', 'https://stats.nba.com/stats/drafthistory?LeagueID=00&Season=2025&RoundNum=&RoundPick=&TeamID=0&Overall_Pick=&SeasonType=', 'nba-draft-json'],
    ['player-index', 'https://cdn.nba.com/static/json/staticData/playerIndex.json', 'nba-player-index'],
    ...[2024, 2025].map(year => [`player-index-${year}`, `https://stats.nba.com/stats/playerindex?LeagueID=00&Season=${year}-${String(year + 1).slice(-2)}&Historical=1&TeamID=0&Country=&College=&DraftYear=&DraftPick=&PlayerPosition=&Height=&Weight=&Active=&AllStar=`, 'nba-player-index']),
    ['cha-lal-postponed', 'https://www.nba.com/news/nba-postpones-hornets-vs-lakers-jan-9-2025', 'official-announcement'],
    ['sas-lal-postponed', 'https://www.nba.com/news/lakers-clippers-postponments', 'official-announcement'],
    ['wildfire-reschedule', 'https://pr.nba.com/nba-game-schedule-adjustments-1-15-25/', 'official-announcement'],
    ['sas-lal-reschedule', 'https://www.nba.com/spurs/news/san-antonio-spurs-announce-schedule-changes', 'official-announcement'],
    ['nba-trade-2025', 'https://www.nba.com/news/luka-doncic-joins-lakers-after-trade-from-mavericks', 'official-announcement'],
    ['nba-trade-2026', 'https://www.nba.com/news/james-harden-darius-garland-trade', 'official-announcement'],
  ]
  const rows = []
  for (const [key, url, kind] of requests) {
    const { row } = await source(key, url, kind)
    rows.push(row)
    console.log(JSON.stringify({ key, status: row.status, bytes: row.bytes, failure: row.failure }))
  }
  await writeJson(path.join(directory, 'source-attempts.json'), { provenance: 'REAL-DERIVED', rows,...sourceProblems(rows) })
  return rows
}
