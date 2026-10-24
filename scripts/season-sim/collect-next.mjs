import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { laneDirectory, miniRoot, season, sha256, writeJson } from './common.mjs'

export async function collectNextSchedule() {
  const directory = await laneDirectory(path.join(miniRoot, 'fixtures'))
  const url = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json'
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nba.com/' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  const evidence = { url, retrievedAt: new Date().toISOString(), status: response.status, bytes: bytes.length, sha256: sha256(bytes), provenance: 'REAL-RAW' }
  await writeFile(path.join(directory, `next-schedule-${evidence.sha256}.json`), bytes)
  assert.equal(response.status, 200, 'Published next-season schedule must be available')
  const payload = JSON.parse(bytes.toString())
  evidence.seasonYear = payload.leagueSchedule?.seasonYear
  evidence.file = `next-schedule-${evidence.sha256}.json`
  await writeJson(path.join(directory, 'next-schedule-source.json'), evidence)
  assert.equal(evidence.seasonYear, `${season.year}-${String(season.year + 1).slice(-2)}`, 'Refuse a different NBA schedule year')
  assert.ok(payload.leagueSchedule.gameDates.flatMap(day => day.games).some(game => game.gameId.startsWith(`002${String(season.year).slice(-2)}`)), 'Next season requires published regular-season games')
  return evidence
}

export async function comparePinnedManifest(pinned, current = path.join(miniRoot, 'fixtures/manifest.jsonl')) {
  const read = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const previous = new Map((await read(pinned)).map(row => [row.key, row]))
  const latest = new Map((await read(current)).map(row => [row.key, row]))
  const rows = [...latest.values()].filter(row => /^(boxscore|playbyplay)-/.test(row.key) && row.status === 200 && row.provenance === 'REAL-RAW').map(row => ({ key: row.key, sha256: row.sha256, pinnedSha256: previous.get(row.key)?.sha256 ?? null, result: !previous.has(row.key) ? 'unmatched' : previous.get(row.key).sha256 === row.sha256 ? 'match' : 'mismatch' }))
  return { pinnedFrom: pinned, current, comparedAt: new Date().toISOString(), rows, counts: Object.fromEntries(['match', 'mismatch', 'unmatched'].map(key => [key, rows.filter(row => row.result === key).length])) }
}
