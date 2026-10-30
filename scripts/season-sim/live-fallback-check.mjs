import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function recordedLiveFeeds(sessionFile) {
  const root = new URL('../../tests/fixtures/live-espn/', import.meta.url)
  const files = sessionFile ? JSON.parse(await readFile(new URL(sessionFile, root), 'utf8')).files :
    (await readdir(root)).filter(file => file.endsWith('.json') && !file.startsWith('capture-session-'))
  return await Promise.all(files.sort().map(async file => ({ file, ...JSON.parse(await readFile(new URL(file, root), 'utf8')) })))
}

export function recordedPointChanges(records) {
  const games = Map.groupBy(records.filter(row => row.file.includes('-summary-')), row => row.payload.header.id)
  const changes = []
  for (const [gameId, rows] of games) {
    const plays = new Map(rows.flatMap(row => row.payload.plays ?? []).map(play => [play.id, play]))
    const cumulative = new Map(), scoring = []
    for (const play of [...plays.values()].sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber))) {
      const id = play.participants?.[0]?.athlete?.id
      if (!id || !play.scoringPlay || !play.scoreValue || !play.wallclock) continue
      const points = (cumulative.get(id) ?? 0) + play.scoreValue
      cumulative.set(id, points)
      scoring.push({ id, points, at: play.wallclock })
    }
    const previous = new Map()
    for (const row of rows) {
      for (const team of row.payload.boxscore.players) for (const group of team.statistics) {
        const column = group.names.indexOf('PTS')
        if (column < 0) continue
        for (const athlete of group.athletes.filter(row => !row.didNotPlay)) {
          const id = athlete.athlete.id, points = Number(athlete.stats[column]), before = previous.get(id)
          if (before != null && points > before) {
            const play = scoring.find(play => play.id === id && play.points >= points)
            if (play && Date.parse(play.at) <= Date.parse(row.receivedAt)) changes.push({ gameId, espnId: id, points, changedAt: play.at, recordedAt: row.receivedAt,
              observedLagMs: Date.parse(row.receivedAt) - Date.parse(play.at), file: row.file })
          }
          previous.set(id, points)
        }
      }
    }
  }
  return changes
}

export function recordedReplayRounds(records, pollIntervalMs = 20_000) {
  const boards = records.filter(row => row.file.includes('-scoreboard.json') && !row.file.includes('-nba-'))
  const intervals = boards.slice(1).map((row, index) => Date.parse(row.requestedAt) - Date.parse(boards[index].requestedAt)).sort((a, b) => a - b)
  const interval = intervals[Math.floor(intervals.length / 2)] ?? pollIntervalMs
  const stride = Math.max(1, Math.round(pollIntervalMs / interval))
  const rounds = boards.map((board, index) => {
    const start = Date.parse(board.requestedAt), end = boards[index + 1] ? Date.parse(boards[index + 1].requestedAt) : Infinity
    const rows = records.filter(row => Date.parse(row.requestedAt) >= start && Date.parse(row.requestedAt) < end)
    const summaries = rows.filter(row => row.file.includes('-summary-'))
    const nba = rows.filter(row => row.file.includes('-nba-'))
    return { index, board, summaries, espnAt: Math.max(Date.parse(board.receivedAt), ...summaries.map(row => Date.parse(row.receivedAt))),
      nbaAt: Math.max(Date.parse(board.receivedAt), ...nba.map(row => Date.parse(row.receivedAt))) }
  })
  const selected = rounds.filter(row => row.index % stride === 0)
  const last = rounds.at(-1)
  if (last && selected.at(-1) !== last) {
    const first = rounds[0]
    selected.push({ ...last,
      espnAt: first.espnAt + Math.ceil((last.espnAt - first.espnAt) / pollIntervalMs) * pollIntervalMs,
      nbaAt: first.nbaAt + Math.ceil((last.nbaAt - first.nbaAt) / pollIntervalMs) * pollIntervalMs })
  }
  return selected
}

export const percentile95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changes = recordedPointChanges(await recordedLiveFeeds())
  assert.ok(changes.length >= 2, 'Record successive scoring changes from both games')
  console.log(JSON.stringify({ measurement: 'Scoring-play wall clock to first recorded player points; database publication is measured separately', samples: changes.length,
    p95ObservedLagMs: percentile95(changes.map(row => row.observedLagMs)), changes }, null, 2))
}
