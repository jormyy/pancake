import path from 'node:path'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fixtureDirectory, laneDirectory, miniRoot, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { compareFinalCounts } from './snapshots.mjs'

export async function audit(options) {
  const fixtures = await laneDirectory(options.fixtures ?? fixtureDirectory)
  const evidence = await laneDirectory(options.evidence ?? path.join(miniRoot, 'evidence'))
  const store = await fixtureStore(fixtures)
  const games = [...store.manifest.values()].filter(row => row.kind === 'nba-boxscore' && row.status === 200)
  const known = JSON.parse(await readFile(new URL('./known-discrepancies.json', import.meta.url), 'utf8'))
  const report = { checkedGames: 0, matchingGames: 0, mutationDetected: false, missingPlayByPlay: [], differences: [], knownSourceDiscrepancies: [], unexpectedDifferences: [], limitations: ['Counting statistics only. Court reconstruction has a separate discrepancy report.', 'This audit does not run the app or prove business invariants.'] }
  for (const entry of games.slice(0, options.games ?? games.length)) {
    const id = entry.key.slice('boxscore-'.length)
    if (store.manifest.get(`playbyplay-${id}`)?.status !== 200) { report.missingPlayByPlay.push(id); continue }
    const box = await store.json(entry.key)
    const pbp = await store.json(`playbyplay-${id}`)
    const differences = compareFinalCounts(box, pbp)
    if (!report.mutationDetected) {
      const changed = structuredClone(box)
      changed.game.homeTeam.players[0].statistics.points += 1
      assert.notDeepEqual(compareFinalCounts(changed, pbp), differences, 'The oracle must reject a changed final count')
      report.mutationDetected = true
    }
    report.checkedGames++
    if (differences.length) {
      const entry = { id, differences }
      report.differences.push(entry)
      const accepted = known.find(item => item.id === id)
      if (JSON.stringify(accepted) === JSON.stringify(entry)) report.knownSourceDiscrepancies.push(entry)
      else report.unexpectedDifferences.push(entry)
    }
    else report.matchingGames++
  }
  await writeJson(path.join(evidence, 'snapshot-audit.json'), report)
  const provenanceFile = path.join(evidence, 'provenance.md')
  const provenance = await readFile(provenanceFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return '# Historical fixture coverage\n'; throw error })
  await writeFile(provenanceFile, `${provenance.split('\n## Snapshot audit')[0]}\n## Snapshot audit\n\nChecked ${report.checkedGames} games; ${report.matchingGames} match all reconstructed counting statistics. ${report.differences.length} games have differences between the official play-by-play and final box score. ${report.missingPlayByPlay.length} games lack play-by-play.\n\nChanged-final negative control detected: ${report.mutationDetected}.\n\n${report.differences.map(entry => `- ${entry.id}: ${entry.differences.map(item => `${item.name ?? item.side} ${item.field}: final ${item.expected}, play-by-play ${item.actual}`).join('; ')}`).join('\n')}\n\nOnly exact entries in known-discrepancies.json are accepted provider discrepancies. Unexpected differences fail the audit. Live snapshots retain PBP values; official raw finals must win. No missing events or correction timestamps are invented. Minutes and plus-minus are reconstructed separately from substitutions and period starters; court-audit.json records unresolved differences. Details: snapshot-audit.json.\n`)
  console.log(JSON.stringify({ checkedGames: report.checkedGames, matchingGames: report.matchingGames, differingGames: report.differences.length, missingPlayByPlay: report.missingPlayByPlay.length }))
  if (!report.checkedGames || report.unexpectedDifferences.length || report.missingPlayByPlay.length) process.exitCode = 1
}
