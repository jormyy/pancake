import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('tests/fixtures/live-espn')
const base = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.split('=')[1] ?? 1)
const intervalMs = Number(process.argv.find(arg => arg.startsWith('--interval-ms='))?.split('=')[1] ?? 20_000)
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 30)
assert.ok(Number.isInteger(intervalMs) && intervalMs >= 10_000 && intervalMs <= 30_000)
const contentOrigin = process.argv.includes('--contentorigin')
const session = { contentOrigin, startedAt: new Date().toISOString(), intervalMs, rounds, files: [], ticks: [] }
await mkdir(root, { recursive: true })
async function capture(name, url) {
  const requestedAt = new Date().toISOString()
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: url.includes('cdn.nba.com') ? { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Origin: 'https://www.nba.com', Referer: 'https://www.nba.com/' } : {} })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const payload = await response.json()
  const receivedAt = new Date().toISOString()
  const file = `${requestedAt.replaceAll(':', '-')}-${name}.json`
  await writeFile(path.join(root, file), `${JSON.stringify({ requestedAt, receivedAt, url, headers: Object.fromEntries(['date', 'last-modified', 'age', 'cache-control'].map(key => [key, response.headers.get(key)])), payload })}\n`)
  session.files.push(file)
  console.log(JSON.stringify({ file, receivedAt }))
  return payload
}
for (let round = 0; round < rounds; round++) {
  const started = Date.now()
  const first = session.files.length
  const board = await capture('scoreboard', `${base}/scoreboard`)
  for (const event of board.events ?? []) {
    if (event.status?.type?.state === 'in') await capture(`summary-${event.id}`, `${base}/summary?event=${event.id}${contentOrigin ? '&contentorigin=espn&region=us&lang=en' : ''}`)
  }
  try {
    const nba = await capture('nba-scoreboard', 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json')
    for (const game of nba.scoreboard?.games ?? []) {
      if (game.gameStatus === 2) await capture(`nba-boxscore-${game.gameId}`, `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${game.gameId}.json`)
    }
  } catch (error) {
    await writeFile(path.join(root, `${new Date().toISOString().replaceAll(':', '-')}-nba-error.json`), `${JSON.stringify({ recordedAt: new Date().toISOString(), error: error.message })}\n`)
    console.error(error.message)
  }
  session.ticks.push({ requestedAt: new Date(started).toISOString(), files: session.files.slice(first) })
  if (round + 1 < rounds) await new Promise(resolve => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))))
}
session.finishedAt = new Date().toISOString()
await writeFile(path.join(root, `capture-session-${session.startedAt.replaceAll(':', '-')}.json`), `${JSON.stringify(session, null, 2)}\n`)
