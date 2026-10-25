import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { dates, delay, etDate, historicalSummary, laneDirectory, miniRoot, readGzip, scheduleEntries, season, sha256, writeGzip, writeJson } from './common.mjs'

const espn = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const cdn = 'https://cdn.nba.com/static/json'
const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' }

export async function collect(options) {
  const directory = await laneDirectory(options.fixtures ?? path.join(miniRoot, 'fixtures'))
  const evidence = await laneDirectory(options.evidence ?? path.join(miniRoot, 'evidence'))
  const manifestFile = path.join(directory, 'manifest.jsonl')
  const previous = await readFile(manifestFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const manifest = new Map(previous.trim().split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.key, row] }))
  const start = options.start ?? season.start
  assert.ok(start >= season.start && start <= season.end, 'Select a date within the pinned regular season')
  const end = options.days ? dates(start, season.end).slice(0, options.days).at(-1) : season.end
  assert.ok(end, 'No days selected')
  let fetched = 0

  async function source(key, url, kind) {
    const cached = manifest.get(key)
    if (cached?.status === 200) {
      assert.equal(path.basename(cached.file), cached.file, 'Fixture path escapes its directory')
      const bytes = gunzipSync(await readFile(path.join(directory, cached.file)))
      assert.equal(sha256(bytes), cached.sha256, `Fixture checksum mismatch: ${key}`)
      return JSON.parse(bytes.toString('utf8'))
    }
    if (cached?.status === 404 && !options.retryMissing) return null
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(attempt ? 1000 * 2 ** attempt : 250)
      let status = null, bytes = Buffer.alloc(0), failure = null
      const retrievedAt = new Date().toISOString()
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' })
        status = response.status
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) { failure = error.message }
      const file = `${key}-${sha256(bytes)}.json.gz`
      await writeGzip(path.join(directory, file), bytes)
      const row = { key, url, kind, provenance: 'REAL-RAW', retrievedAt, status, bytes: bytes.length, sha256: sha256(bytes), file, attempt: attempt + 1, failure }
      await appendFile(manifestFile, `${JSON.stringify(row)}\n`)
      manifest.set(key, row)
      fetched++
      if (fetched % 50 === 0) console.log(JSON.stringify({ event: 'download', fetched, latest: key, status }))
      if (status === 200) return JSON.parse(bytes.toString('utf8'))
      if (status === 404 || (status != null && status < 500 && status !== 429 && status !== 403)) return null
    }
    return null
  }

  const schedule = []
  for (const day of dates(start, end)) {
    const payload = await source(`scoreboard-${day}`, `${espn}/scoreboard?dates=${day.replaceAll('-', '')}&limit=1000`, 'espn-scoreboard')
    schedule.push(...scheduleEntries(payload, day))
  }
  await writeJson(path.join(directory, 'schedule.json'), { provenance: 'REAL-DERIVED', start, end, games: schedule })
  console.log(JSON.stringify({ event: 'schedule', entries: schedule.length, completed: schedule.filter(game => game.completed).length, postponed: schedule.filter(game => game.status === 'STATUS_POSTPONED').length }))

  const allGames = new Map()
  const count = options.games ?? season.games
  let nextId = 1
  async function worker() {
    while (nextId <= count) {
      const id = `${season.prefix}${String(nextId++).padStart(5, '0')}`
      const box = await source(`boxscore-${id}`, `${cdn}/liveData/boxscore/boxscore_${id}.json`, 'nba-boxscore')
      if (!box?.game) continue
      assert.equal(box.game.gameId, id)
      const game = box.game
      const date = etDate(game.gameEt ?? game.gameTimeUTC)
      allGames.set(id, { id, date, time: game.gameTimeUTC, home: game.homeTeam.teamTricode, away: game.awayTeam.teamTricode, status: game.gameStatus })
      if (date < start || date > end) continue
      await source(`playbyplay-${id}`, `${cdn}/liveData/playbyplay/playbyplay_${id}.json`, 'nba-playbyplay')
      const matches = schedule.filter(item => item.date === date && item.home === game.homeTeam.teamTricode && item.away === game.awayTeam.teamTricode && item.completed)
      if (matches.length === 1) {
        allGames.get(id).espnId = matches[0].espnId
        await source(`summary-${matches[0].espnId}`, `${espn}/summary?event=${matches[0].espnId}`, 'espn-summary')
      }
    }
  }
  await Promise.all([worker(), worker()])
  await writeJson(path.join(directory, 'games.json'), { provenance: 'REAL-DERIVED', sourceManifest: manifestFile, games: [...allGames.values()].sort((a, b) => a.id.localeCompare(b.id)) })
  await report(directory, evidence, manifest, schedule, [...allGames.values()], start, end)
}

async function report(directory, evidence, manifest, schedule, games, start, end) {
  const selected = games.filter(game => game.date >= start && game.date <= end)
  const coverage = { start, end, scheduleEntries: schedule.length, playedScheduleEntries: schedule.filter(game => game.completed).length, postponedEntries: schedule.filter(game => game.status === 'STATUS_POSTPONED').length, boxScores: selected.length, pbpFiles: 0, summaries: 0, historicalInjuryReports: 0, dateQualifiedEspnInjuryCandidates: 0, inactivePlayerReasons: 0, historicalNewsItems: 0, rejectedCurrentInjuries: 0, rejectedCurrentNews: 0 }
  const gaps = []
  const missingHistoricalNews = []
  for (const game of selected) {
    if (manifest.get(`playbyplay-${game.id}`)?.status === 200) coverage.pbpFiles++
    else gaps.push(`Missing NBA play-by-play: ${game.id}`)
    const box = await readGzip(path.join(directory, manifest.get(`boxscore-${game.id}`).file))
    for (const team of [box.game.homeTeam, box.game.awayTeam]) {
      coverage.inactivePlayerReasons += team.players.filter(player => player.notPlayingReason).length
      coverage.historicalInjuryReports += team.players.filter(player => player.notPlayingReason?.includes('INJURY')).length
    }
    if (game.espnId && manifest.get(`summary-${game.espnId}`)?.status === 200) {
      coverage.summaries++
      const payload = await readGzip(path.join(directory, manifest.get(`summary-${game.espnId}`).file))
      const history = historicalSummary(payload, box.game.gameEt)
      coverage.dateQualifiedEspnInjuryCandidates += history.injuries.length
      coverage.historicalNewsItems += history.news.length
      if (!history.news.length) missingHistoricalNews.push(game.id)
      coverage.rejectedCurrentInjuries += history.rejectedInjuries
      coverage.rejectedCurrentNews += history.rejectedNews
    } else gaps.push(`Missing matched ESPN summary: ${game.id}`)
  }
  for (const game of schedule.filter(game => game.completed)) {
    if (!selected.some(candidate => candidate.espnId === game.espnId)) gaps.push(`No matched NBA final: ESPN ${game.espnId} ${game.date} ${game.away}@${game.home}`)
  }
  for (const day of dates(start, end)) if (manifest.get(`scoreboard-${day}`)?.status !== 200) gaps.push(`Missing ESPN date: ${day}`)
  if (start === season.start && end === season.end && coverage.playedScheduleEntries !== season.games) gaps.push(`Expected ${season.games} played games; found ${coverage.playedScheduleEntries}`)
  const perTeam = {}
  for (const game of schedule.filter(game => game.completed)) for (const team of [game.home, game.away]) perTeam[team] = (perTeam[team] ?? 0) + 1
  if (start === season.start && end === season.end && (Object.keys(perTeam).length !== 30 || Object.values(perTeam).some(count => count !== 82))) gaps.push('Full-season 30-team / 82-game check fails')
  const classes = { 'REAL-RAW': [...manifest.values()].filter(row => row.status === 200).length, 'REAL-DERIVED': 2, SYNTHETIC: 0 }
  const sourceGaps = ['No historical general-news feed snapshot is available.', 'ESPN injury sections are current; historical injury counts use NBA inactive injury reasons.', 'Postponement announcement timestamps remain unverified.', 'Original live stat-correction revisions and their publication times are unavailable.', ...missingHistoricalNews.map(id => `No dated historical news or recap in the ESPN summary for ${id}.`)]
  const result = { ...coverage, perTeam, classes, classUnit: 'stored fixture artifacts; derived schedule.json and games.json', manifest: path.join(directory, 'manifest.jsonl'), gaps, sourceGaps, complete: gaps.length === 0 && selected.length === coverage.playedScheduleEntries }
  await writeJson(path.join(evidence, 'coverage.json'), result)
  await writeFile(path.join(evidence, 'provenance.md'), `# Historical fixture coverage\n\n${Object.entries(coverage).map(([key, value]) => `- ${key}: ${value}`).join('\n')}\n\n## Provenance\n\n${Object.entries(classes).map(([key, value]) => `- ${key}: ${value} artifacts`).join('\n')}\n\nManifest: ${result.manifest}\n\nSHA-256 hashes cover decompressed response bytes. Each attempt records URL, retrieval time, HTTP status, size, and hash. Raw summaries contain current injury/news sections. Date checks exclude entries outside seven days before or two days after the historical game. Date-qualified ESPN injuries remain unverified candidates; the historical injury count uses only NBA game-box injury reasons. Game recap articles and NBA inactive reasons are the real substitutes. Their replay feeds must be labeled REAL-DERIVED. Published timestamps govern when news becomes visible. No historical correction snapshots have been sourced. No synthetic overlays have been generated at collection time.\n\n## File coverage gaps\n\n${gaps.length ? gaps.map(gap => `- ${gap}`).join('\n') : 'No missing selected game files.'}\n\nComplete selected file coverage: ${result.complete}. This does not prove simulator or business-invariant coverage.\n\n## Historical source gaps\n\n${sourceGaps.map(gap => `- ${gap}`).join('\n')}\n`)
  console.log(JSON.stringify({ event: 'coverage', ...result }))
  if (!result.complete) process.exitCode = 1
}
