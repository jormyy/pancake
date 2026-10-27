import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { calendarOracle } from './calendar-oracle.mjs'
import { fixtureDirectory, sha256 } from './common.mjs'
import { scenarioBounds } from './scenario-profile.mjs'

export async function officialInputs(profile) {
  const files = ['two-season-plan.json', 'games.json', 'manifest.jsonl']
  const bytes = await Promise.all(files.map(file => readFile(path.join(fixtureDirectory, file))))
  const plan = JSON.parse(bytes[0].toString('utf8')), { games } = JSON.parse(bytes[1].toString('utf8'))
  assert.equal(plan.mode, 'two-real-seasons')
  assert.ok(games.every(game => game.provenance !== 'SYNTHETIC'), 'Official input games must have real historical provenance')
  const seasons = plan.seasons.map(season => {
    const selected = games.filter(game => game.id.startsWith(season.prefix))
    const calendar = calendarOracle(selected)
    return { ...season, start: calendar.opening, end: calendar.end, calendar }
  })
  const bounds = scenarioBounds(profile, seasons)
  assert.equal(bounds.checkpoint, '2025-02-10')
  assert.equal(bounds.playoffStart, '2025-02-24')
  assert.equal(bounds.playoffEnd, '2025-03-23')
  return { ...plan, seasons, games, bounds, metadataLimits: ['Historical Hashtag rankings and FantasyPros projection archives are absent; native workers receive explicit local unavailable responses', 'Dated game observations exclude future games; retroactive provider metadata has no independently proved original publication timestamp', 'Historical Sleeper identities and projections are absent', 'Historical fine position eligibility is incomplete; broad G/F positions do not imply PG/SG/SF/PF eligibility', 'Historical injury observations begin with retained completed games', 'Future-season schedules use the retained synthetic August 15 availability policy; original publication time is unproved'], files: files.map((name, index) => ({ name, sha256: sha256(bytes[index]) })) }
}
