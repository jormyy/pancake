import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function upstreamRecorder(directory, { resume = false } = {}) {
  const report = resume ? JSON.parse(readFileSync(path.join(directory, 'upstream-summary.json'), 'utf8')) : { deliveries: 0, classes: {}, paths: {}, games: {}, rawSampleLimit: 5000, rawSampleEvery: 100, rawSampleRows: 0 }
  const save = () => writeFileSync(path.join(directory, 'upstream-summary.json'), JSON.stringify(report))
  const record = event => {
    event.realAt = new Date().toISOString()
    report.deliveries++
    report.classes[event.provenance] = (report.classes[event.provenance] ?? 0) + 1
    const route = event.path.replace(/boxscore_\d+/, 'boxscore_GAME').replace(/athletes\/\d+/, 'athletes/PLAYER')
    report.paths[route] = (report.paths[route] ?? 0) + 1
    for (const id of event.scoreboardGames ?? []) (report.games[id] ??= { finalRaw: 0, live: {}, scoreboard: 0, synthetic: 0 }).scoreboard++
    if (event.gameId) {
      const game = report.games[event.gameId] ??= { finalRaw: 0, live: {}, scoreboard: 0, synthetic: 0 }
      if (event.provenance === 'SYNTHETIC') game.synthetic++
      else if (event.kind === 'scoreboard') game.scoreboard++
      else if (event.gameStatus === 3 && event.provenance === 'REAL-RAW') game.finalRaw++
      else if (event.gameStatus === 2) game.live[`${event.period}:${event.gameClock}`] = event.at
    }
    if (report.deliveries <= report.rawSampleLimit || report.deliveries % report.rawSampleEvery === 0) {
      appendFileSync(path.join(directory, 'upstream-events.jsonl'), `${JSON.stringify(event)}\n`)
      report.rawSampleRows++
    }
    if (report.deliveries % 1000 === 0) save()
  }
  return { report, record, save }
}
