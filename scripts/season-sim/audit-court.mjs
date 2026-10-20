import path from 'node:path'
import { fixtureStore } from './fixtures.mjs'
import { miniRoot, writeJson } from './common.mjs'
import { courtTime, clockSeconds } from './court.mjs'
import { orderedActions } from './snapshots.mjs'

export async function auditCourt() {
  const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
  const report = { games: 0, reconstructed: 0, errors: [], differences: [] }
  for (const entry of store.manifest.values()) {
    if (entry.kind !== 'nba-boxscore' || entry.status !== 200) continue
    const box = await store.json(entry.key)
    const id = box.game.gameId
    report.games++
    try {
      const all = orderedActions(await store.json(`playbyplay-${id}`))
      const court = courtTime(box, all, all)
      report.reconstructed++
      const differences = []
      for (const team of [box.game.homeTeam, box.game.awayTeam]) for (const player of team.players) {
        const time = court.get(player.personId)
        const seconds = clockSeconds(player.statistics.minutes)
        if (Math.abs(time.seconds - seconds) > 1.1 || time.plus - time.minus !== player.statistics.plusMinusPoints) differences.push({ player: player.personId, name: player.name, officialSeconds: seconds, derivedSeconds: Math.round(time.seconds * 100) / 100, officialPlusMinus: player.statistics.plusMinusPoints, derivedPlusMinus: time.plus - time.minus })
      }
      if (differences.length) report.differences.push({ id, differences })
    } catch (error) { report.errors.push({ id, error: error.message }) }
  }
  await writeJson(path.join(miniRoot, 'evidence/court-audit.json'), report)
  console.log(JSON.stringify({ games: report.games, reconstructed: report.reconstructed, errors: report.errors.length, differences: report.differences.length }))
}
