#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const usage = 'usage: public-web.mjs --api=URL [--frontend=URL] [--name=LEAGUE] [--ambiguous=TEXT] [--missing=TEXT] [--forbid-file=FILE] [--receipt=FILE] [--limit-ip=IP]'
if (!options.api) { console.error(usage); process.exit(2) }
const api = options.api.replace(/\/+$/, '')
const contract = JSON.parse(await readFile(path.join(root, 'packages/pancake-cli/schemas/v2.json'), 'utf8'))
const choices = JSON.parse(await readFile(path.join(root, 'packages/pancake-cli/schemas/options-v2.json'), 'utf8'))
const forbidden = options['forbid-file'] ? (await readFile(options['forbid-file'], 'utf8')).split('\n').map(line => line.trim()).filter(Boolean) : []
const receipt = { api, startedAt: new Date().toISOString(), reads: 0, checks: [], failures: [], skipped: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const columns = resource => Object.keys(contract.resources[resource].properties.items.items.properties)
const cell = value => value === null || value === undefined ? '—' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
const check = (name, passed, detail = '') => { receipt.checks.push({ name, passed, ...(detail ? { detail } : {}) }); if (!passed) receipt.failures.push(name) }

async function get(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    let response
    try { response = await fetch(url, { headers }) } catch (error) { receipt.reads++; return { status: 0, text: String(error.cause?.code ?? error.message), headers: new Headers() } }
    receipt.reads++
    const text = await response.text()
    if (response.status === 429 && !headers['cf-connecting-ip'] && attempt < 3) { await sleep(Number(response.headers.get('retry-after') ?? 60) * 1000 + 250); continue }
    for (const secret of forbidden) if (text.includes(secret)) receipt.failures.push(`private fixture text in ${new URL(url).pathname}`)
    return { status: response.status, text, headers: response.headers }
  }
}
const query = params => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString()
const json = async (resource, params) => { const page = await get(`${api}/public/v2/${resource}?${query(params)}`); return page.status === 200 ? JSON.parse(page.text) : { status: page.status } }
function table(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line, index) => line.startsWith('| ') && lines[index + 1]?.startsWith('| ---'))
  if (start < 0) return { header: [], rows: [] }
  const split = line => line.slice(2, -2).split(/(?<!\\)\| /).map(part => part.trim())
  const rows = []
  for (let index = start + 2; index < lines.length && lines[index].startsWith('| '); index++) rows.push(split(lines[index]))
  return { header: split(lines[start]), rows }
}

async function parity(resource, params, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await json(resource, params)
    const page = await get(`${api}/public/web/${resource}?${query(params)}`)
    if (data.status || page.status !== 200) {
      if (data.status === page.status) return check(`${label} same status ${page.status}`, true)
      if (attempt) return check(`${label} status`, false, `json ${data.status ?? 200} web ${page.status}`)
      continue
    }
    const { header, rows } = table(page.text)
    const fields = columns(resource)
    const expected = data.items.map(item => fields.map(field => cell(item[field])))
    const actual = rows.map(row => row.slice(0, fields.length))
    const headerOk = data.items.length === 0 || JSON.stringify(header.slice(0, fields.length)) === JSON.stringify(fields)
    const rowsOk = JSON.stringify(actual) === JSON.stringify(expected)
    const cursorOk = data.nextCursor ? page.text.includes(`cursor=${encodeURIComponent(data.nextCursor)}`) : page.text.includes('This is the last page.')
    const contextOk = resource === 'leagues' || (/^- League: .+\(id [0-9a-f-]{36}\)/m.test(page.text) && /^- Season: /m.test(page.text))
    const fresh = /^- Freshness: read live from the Pancake database at \d{4}-\d\d-\d\dT[\d:.]+Z/m.test(page.text)
    if (headerOk && rowsOk && cursorOk && contextOk && fresh) return { data, page, passed: check(`${label} (${data.items.length} records)`, true) }
    if (attempt) return check(label, false, JSON.stringify({ headerOk, rowsOk, cursorOk, contextOk, fresh, json: data.items.length, web: rows.length }))
  }
}

const start = options.frontend ? await get(options.frontend.replace(/\/+$/, '') + '/') : null
let startUrl = `${api}/public/web`
if (start) {
  const block = start.text.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? ''
  const browse = block.match(/<a href="([^"]+)">Browse public leagues<\/a>/)?.[1]
  check('homepage HTML links to public leagues without JavaScript', Boolean(browse), browse ?? 'no link')
  check('homepage advertises the Markdown pages', /<link rel="alternate" type="text\/markdown"[^>]*href="[^"]+\/public\/web"/.test(start.text))
  if (browse) startUrl = browse.replace(/&amp;/g, '&')
}
const index = await get(startUrl)
check('start page is Markdown with league links', index.status === 200 && /text\/markdown/.test(index.headers.get('content-type') ?? '') && index.text.startsWith('# Pancake public league data'))
const leagues = table(index.text).rows
const target = options.name ? leagues.find(row => row[1] === options.name) : leagues[0]
check('start page lists the named league', Boolean(target), options.name ?? 'first league')
if (!target) { await finish(); process.exit(1) }
const [leagueId, leagueName] = target
const homeLink = target[target.length - 1].match(/\((https?:[^)]+)\)/)?.[1]
check('league row links to its league home', Boolean(homeLink) && homeLink.endsWith(`league=${leagueId}`))
const searches = [
  ['full name', leagueName, /One public league name contains|Exact name match/],
  ['partial lower-case name', leagueName.toLowerCase().slice(Math.floor(leagueName.length / 3), Math.floor(leagueName.length / 3) + Math.max(3, Math.ceil(leagueName.length / 3))), null],
  ['missing name', options.missing ?? 'zz-no-such-league-zz', 'No public league name contains'],
  ...(options.ambiguous ? [['ambiguous name', options.ambiguous, 'The name is ambiguous']] : []),
]
for (const [label, text, phrase] of searches) {
  const page = await get(`${api}/public/web/leagues?${query({ query: text })}`)
  const rows = table(page.text).rows
  const found = rows.some(row => row[0] === leagueId)
  const passed = page.status === 200 && (phrase ? new RegExp(phrase).test(page.text) : found) && (label === 'missing name' ? rows.length === 0 : label === 'ambiguous name' ? rows.length > 1 : found)
  check(`search by ${label} "${text}"`, passed, `${rows.length} matches`)
  await parity('leagues', { query: text }, `leagues query=${label}`)
}
if (!options.ambiguous) receipt.skipped.push('ambiguous search needs --ambiguous')
const home = await get(homeLink ?? `${api}/public/web/league?league=${leagueId}`)
check('league home names the league, season and freshness', home.status === 200 && home.text.startsWith(`# ${leagueName}: League settings`) && /^- Season: \d{4}/m.test(home.text))
const linked = [...home.text.matchAll(/^- [^:]+: (https?:\S+\/public\/web\/([a-z-]+)\?\S+)$/gm)].map(match => match[2])
check('league home links every league resource', ['seasons', 'teams', 'players', 'free-agents', 'standings', 'matchups', 'scores', 'schedule', 'player-stats', 'projections', 'drafts', 'draft-results', 'picks', 'trades', 'transactions'].every(name => linked.includes(name)))

const base = { league: leagueId }
const first = async (resource, params = {}) => (await json(resource, { ...base, ...params, limit: 50 })).items ?? []
const teams = await first('teams'), players = await first('players'), seasons = await first('seasons')
const drafts = await first('drafts'), trades = await first('trades')
const values = {
  team: teams[0]?.id, player: players[0]?.id, draft: drafts[0]?.id, trade: trades[0]?.id, week: 1,
  position: players.find(item => item.position)?.position, query: (players[0]?.name ?? teams[0]?.name ?? leagueName).slice(0, 3),
  season: seasons.find(item => item.isCurrent)?.seasonYear ?? seasons[0]?.seasonYear,
}
for (const [resource, choice] of Object.entries(choices)) {
  if (resource === 'leagues') continue
  const scope = { ...base, ...(resource === 'rosters' ? { team: values.team } : {}) }
  await parity(resource, scope, `${resource} defaults`)
  const paged = await parity(resource, { ...scope, limit: 2 }, `${resource} limit=2`)
  if (paged?.data?.nextCursor) await parity(resource, { ...scope, limit: 2, cursor: paged.data.nextCursor }, `${resource} second page`)
  for (const filter of choice.filters) {
    if (resource === 'rosters' && filter === 'team') continue
    if (values[filter] === undefined) { receipt.skipped.push(`${resource} ${filter}: no public value`); continue }
    await parity(resource, { ...scope, [filter]: values[filter] }, `${resource} ${filter}=${values[filter]}`)
    if (filter === 'season' && seasons.length > 1) for (const season of seasons) await parity(resource, { ...scope, season: season.seasonYear }, `${resource} season=${season.seasonYear}`)
  }
  for (const sort of choice.sorts) for (const direction of ['asc', 'desc']) await parity(resource, { ...scope, sort, direction, limit: 5 }, `${resource} sort=${sort} ${direction}`)
}
for (const [label, url, status] of [
  ['unknown option', `${api}/public/web/teams?league=${leagueId}&bid=1`, 400],
  ['missing league', `${api}/public/web/teams`, 400],
  ['unknown resource', `${api}/public/web/claims?league=${leagueId}`, 404],
  ['unknown league', `${api}/public/web/league?league=00000000-0000-4000-8000-000000000000`, 404],
]) { const page = await get(url); check(`${label} returns ${status}`, page.status === status && page.text.startsWith('# Pancake public data: error')) }
if (options['limit-ip']) await limit(options['limit-ip'])
await finish()
process.exit(receipt.failures.length ? 1 : 0)

async function limit(ip) {
  const minute = () => Math.floor(Date.now() / 60000)
  while (Date.now() % 60000 > 20000) await sleep(1000)
  const at = minute(), headers = { 'cf-connecting-ip': ip }
  const urls = [`${api}/public/v2/leagues?limit=1`, `${api}/public/web/leagues?limit=1`, `${api}/public/web/league?league=${leagueId}`, `${api}/public/v2/teams?league=${leagueId}&limit=1`]
  const statuses = [], timings = []
  let cursor = 0
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < 240) {
      const index = cursor++, began = performance.now()
      statuses[index] = (await get(urls[index % urls.length], headers)).status
      timings.push(performance.now() - began)
    }
  }))
  timings.sort((a, b) => a - b)
  receipt.limitLatencyMs = { p50: Math.round(timings[119]), p95: Math.round(timings[227]), max: Math.round(timings[239]) }
  const next = await get(urls[1], headers), other = await get(urls[1], { 'cf-connecting-ip': `${ip.split('.').slice(0, 3).join('.')}.${(Number(ip.split('.')[3]) + 1) % 255}` })
  const sameMinute = minute() === at
  check('240 mixed JSON and page reads from one IP are admitted', statuses.every(status => status === 200) && sameMinute, JSON.stringify(statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {})))
  const retry = Number(next.headers.get('retry-after'))
  check('read 241 is limited with Retry-After', next.status === 429 && retry >= 1 && retry <= 60 && sameMinute, `status ${next.status} retry-after ${retry}`)
  check('another IP still reads normally', other.status === 200)
  await sleep(retry * 1000 + 500)
  check('reads resume after the reset', (await get(urls[1], headers)).status === 200)
}
async function finish() {
  receipt.finishedAt = new Date().toISOString()
  receipt.passed = receipt.failures.length === 0
  const summary = `${receipt.checks.filter(item => item.passed).length}/${receipt.checks.length} checks passed, ${receipt.reads} reads, ${receipt.skipped.length} skipped`
  if (options.receipt) await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(summary)
  for (const failure of receipt.failures) console.log(`FAIL ${failure}`)
}
