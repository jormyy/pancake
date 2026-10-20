import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

export const season = { year: 2026, start: '2025-10-21', end: '2026-04-12', games: 1230 }
export function configuration(env = process.env) {
  const prefix = env.SEASON_SIM_PORT_PREFIX ?? '572'
  const project = env.SEASON_SIM_PROJECT ?? 'pt4basim'
  assert.match(prefix, /^57[2-5]$/, 'Use an assigned task port block')
  assert.match(project, /^pt4ba[a-z0-9_-]+$/, 'Use a task-local project')
  const root = env.SEASON_SIM_ROOT ?? path.join(homedir(), 'pancake-t_4ba51e0d/lanes/sim')
  assert.ok(path.isAbsolute(root), 'SEASON_SIM_ROOT must be absolute')
  const container = env.SEASON_SIM_CONTAINER ?? `supabase_db_${project}`
  assert.equal(container, `supabase_db_${project}`, 'Container must belong to the configured project')
  const socket = env.SEASON_SIM_DOCKER_SOCKET ?? env.DOCKER_HOST?.replace(/^unix:\/\//, '')
  if (socket != null) assert.ok(path.isAbsolute(socket) && !socket.includes('://'), 'Docker requires an absolute Unix socket')
  const ports = Object.fromEntries(Object.entries({ api: 21, db: 22, replay: 80, edge: 81, inspector: 83, fault: 89 }).map(([key, suffix]) => [key, Number(`${prefix}${suffix}`)]))
  return { root: path.resolve(root), prefix, project, container, socket, ports,
    cli: env.SEASON_SIM_CLI ?? path.resolve(root, '../../tools/bin/supabase-go') }
}

export const config = configuration()
export const miniRoot = config.root
export const originUrl = kind => `http://127.0.0.1:${config.ports[kind]}`
export const databaseUrl = `postgresql://postgres@127.0.0.1:${config.ports.db}/postgres`
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const etDate = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
export const teamCode = code => ({ GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' })[code] ?? code
const nbaTeams = new Set('ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split(' '))

export function scheduleEntries(payload, day) {
  return (payload?.events ?? []).flatMap(event => {
    const competition = event.competitions?.[0]
    if (event.season?.type !== 2 || !competition || competition.notes?.some(note => note.headline === 'NBA Cup Championship')) return []
    const home = competition.competitors.find(team => team.homeAway === 'home')
    const away = competition.competitors.find(team => team.homeAway === 'away')
    if (!home || !away || ![home, away].every(team => nbaTeams.has(teamCode(team.team.abbreviation)))) return []
    return [{ sourceDate: day, espnId: event.id, time: event.date, date: etDate(event.date), home: teamCode(home.team.abbreviation), away: teamCode(away.team.abbreviation), status: event.status.type.name, completed: event.status.type.completed, notes: competition.notes ?? [], source: `scoreboard-${day}` }]
  })
}

export function assertTarget(value, kind) {
  const url = new URL(value)
  assert.ok(!value.includes('ceeytbfmwsnzalxlkalc'), 'Production is forbidden')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only loopback targets are allowed')
  assert.ok(['api', 'db', 'replay', 'edge'].includes(kind) && url.port === String(config.ports[kind]), `Wrong ${kind} port`)
  assert.ok((kind === 'db' ? ['postgres:', 'postgresql:'] : ['http:']).includes(url.protocol), 'Wrong target protocol')
  assert.equal(url.search, '', 'Target query strings are forbidden')
  assert.equal(url.hash, '', 'Target fragments are forbidden')
  if (kind === 'db') assert.equal(url.pathname, '/postgres', 'Only the configured local postgres database is allowed')
  if (kind !== 'db') {
    assert.equal(url.username, '')
    assert.equal(url.password, '')
    assert.equal(url.pathname, '/', 'An origin is required')
  }
  return url
}

export async function laneDirectory(directory) {
  const root = await realpath(miniRoot)
  const target = path.resolve(directory)
  assert.ok(target.startsWith(`${root}/`) && target !== `${root}/repo`, 'Artifacts must stay under the mini lane folder')
  assert.ok(!target.startsWith(`${root}/repo/`), 'Artifacts must stay outside the repository')
  let ancestor = target
  for (;;) {
    try {
      assert.equal(await realpath(ancestor), ancestor, 'Artifact paths must not contain symlinks')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      ancestor = path.dirname(ancestor)
    }
  }
  await mkdir(target, { recursive: true })
  assert.equal(await realpath(target), target, 'Artifact paths must not contain symlinks')
  return target
}

export async function writeJson(file, value) {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
}

export async function readGzip(file) {
  return JSON.parse(gunzipSync(await readFile(file)).toString('utf8'))
}

export async function writeGzip(file, bytes) {
  await writeFile(`${file}.tmp`, gzipSync(bytes))
  await rename(`${file}.tmp`, file)
}

export function dates(start, end) {
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(end, /^\d{4}-\d{2}-\d{2}$/)
  const result = []
  for (let time = Date.parse(`${start}T12:00:00Z`); time <= Date.parse(`${end}T12:00:00Z`); time += 86400000) {
    result.push(new Date(time).toISOString().slice(0, 10))
  }
  return result
}

export function historicalSummary(payload, gameTime) {
  const start = Date.parse(gameTime) - 7 * 86400000
  const end = Date.parse(gameTime) + 2 * 86400000
  const inWindow = date => Number.isFinite(Date.parse(date)) && Date.parse(date) >= start && Date.parse(date) <= end
  const injuries = (payload.injuries ?? []).flatMap(team => (team.injuries ?? [])
    .filter(injury => inWindow(injury.date))
    .map(injury => ({ team: team.team?.abbreviation, ...injury })))
  const candidates = [...(payload.news?.articles ?? []), ...(payload.article ? [payload.article] : [])]
  const news = [...new Map(candidates.filter(article => inWindow(article.published))
    .map(article => [article.id ?? article.headline, article])).values()]
  return {
    injuries,
    news,
    rejectedInjuries: (payload.injuries ?? []).reduce((sum, team) => sum + (team.injuries?.length ?? 0), 0) - injuries.length,
    rejectedNews: candidates.filter(article => !inWindow(article.published)).length,
  }
}
