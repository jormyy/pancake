import { originUrl } from './common.mjs'
import { verifyCronCatalog } from './cron.mjs'
import { createHash } from 'node:crypto'
import { careerSources, fantasyPaths, fantasyTypes, gapSource, providerTransport, validGapRoute } from './provider-transport.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const playerFailure = 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503'
const injuryFailure = 'ESPN injuries has no mapped statuses; injury_status unchanged'

export function classifyOutcome(outcome, evidence = {}) {
  try { return classifyNativeOutcome(outcome, evidence) } catch { return { kind: 'unexpected', reason: 'Malformed outcome evidence' } }
}

export function sourceGapReference({ phase, outcome, classification }) {
  return { phase, invocationKey: outcome.invocation_key, function: outcome.function_name, gaps: classification.gaps }
}

function classifyNativeOutcome(outcome, { providers = [], at = NaN, draftAvailableAt = '' } = {}) {
  const reject = reason => ({ kind: 'unexpected', reason })
  let body
  try { body = JSON.parse(outcome.content ?? '{}') } catch { return reject('Invalid worker response') }
  if (outcome.error_message && outcome.error_message !== outcome.sync_error && outcome.error_message !== `HTTP ${outcome.status_code}: ${(outcome.content ?? '').slice(0, 500)}`) return reject('Conflicting invocation error')
  if (outcome.timed_out || outcome.error_msg) return reject('Worker transport failure')
  if (!outcome.invocation_key || !['success', 'failed'].includes(outcome.sync_status)) return reject('Missing durable worker outcome')
  if (providers.some(row => row.error || row.status >= 400 && !row.unavailable)) return reject('Unexpected provider failure')
  const known = (source, pathname, status = 503) => {
    const rows = providers.filter(row => row.unavailable?.source === source && pathname(new URL(row.transport).pathname))
    return rows.length > 0 && rows.every(row => {
      const url = new URL(row.transport)
      const gap = row.unavailable
      const origin = row.originReceipt
      return row.invocation === outcome.invocation_key && row.function === outcome.function_name && row.status === status &&
        url.origin === originUrl('replay') && url.origin === outcome.providerOrigin && validGapRoute(source, url) && providerTransport(row.original).href === row.transport && pathname(url.pathname) && row.method === 'GET' &&
        origin?.requestId === row.requestId && origin.transport === row.transport && origin.method === row.method && origin.at === row.at && origin.status === row.status && origin.bodySha256 === row.bodySha256 && JSON.stringify(origin.unavailable) === JSON.stringify(gap) &&
        row.at === gap.at && Date.parse(row.at) <= at &&
        gap.code === 'HISTORICAL_UNAVAILABLE' && gap.policy === 'retained-corpus-v1' &&
        row.bodySha256 === hash(JSON.stringify(source === 'nba-draft-before-publication' ? { error: 'Complete pinned draft board unavailable before declared replay availability', unavailable: gap } : source === 'espn-injury-observations' ? { injuries: [{ injuries: [] }], unavailable: gap } : { unavailable: gap }))
    })
  }
  const failed = outcome.status_code === 500 && outcome.worker_status === 'failed' && outcome.sync_status === 'failed'
  const success = outcome.status_code === 200 && outcome.worker_status === 'success' && outcome.sync_status === 'success' && !outcome.sync_error && !outcome.error_message
  if (success && body?.ok === false) return reject('Worker response reports failure')
  const failure = outcome.sync_error
  const gaps = []
  if (outcome.function_name === 'sync-projections') {
    if (!success || body.ok !== true || !Number.isInteger(body.internalFallback) || body.internalFallback < 0 || body.fantasypros?.length !== 3) return reject('Invalid projection worker result')
    for (const [index, type] of fantasyTypes.entries()) {
      const row = body.fantasypros[index]
      if (row?.projectionType !== type) return reject('Missing projection source outcome')
      if (row.status !== 'failed' || row.rows !== 0 || row.matched !== 0 || row.unmatched !== 0 || row.error !== `FantasyPros ${type} fetch failed with HTTP 503` || !known('fantasypros-projections', path => path === `/fantasypros/nba/projections/${fantasyPaths[index]}`)) return reject('Unexpected projection subresult')
      gaps.push(`fantasypros:${type}`)
    }
  } else if (failed && outcome.function_name === 'sync-rankings' && failure === 'Rankings fetch 503' && known('hashtag-rankings', path => gapSource(path) === 'hashtag-rankings')) gaps.push('hashtag-rankings')
  else if (failed && outcome.function_name === 'sync-sleeper-projections' && failure === 'Sleeper projections HTTP 503' && known('sleeper-projections', path => gapSource(path) === 'sleeper-projections')) gaps.push('sleeper-projections')
  else if (failed && outcome.function_name === 'sync-players' && failure === playerFailure && body.failure === playerFailure && known('sleeper-identities', path => path === '/sleeper/players/nba')) gaps.push('sleeper-identities')
  else if (success && outcome.function_name === 'sync-players' && body.identityRefreshDeferred === true && known('sleeper-identities', path => path === '/sleeper/players/nba')) gaps.push('sleeper-identities')
  else if (failed && outcome.function_name === 'sync-player-injuries' && failure === injuryFailure && body.failure === injuryFailure && body.updated === 0 && known('espn-injury-observations', path => path === '/espn/injuries', 200)) gaps.push('espn-injury-observations')
  else if (failed && outcome.function_name === 'sync-draft-order' && at < Date.parse(draftAvailableAt) && typeof failure === 'string' && failure === draftFailure(new Date(at).getUTCFullYear(), outcome.providerOrigin) && [`/nba/news/${new Date(at).getUTCFullYear()}-nba-draft-order`, `/nba/draft/${new Date(at).getUTCFullYear()}`, '/stats/stats/drafthistory'].every(expected => known('nba-draft-before-publication', path => path === expected))) gaps.push('nba-draft-before-publication')
  else if (!success) return reject('Worker failure has no exact source attribution')
  if (outcome.function_name === 'sync-players' && body.injuryWarnings !== 0) {
    if (body.injuryWarnings !== 1 || !known('espn-injury-observations', path => path === '/espn/injuries', 200)) return reject('Unexpected player injury warning')
    gaps.push('espn-injury-observations')
  }
  for (const source of careerSources) {
    if (!providers.some(row => row.unavailable?.source === source)) continue
    if (outcome.function_name !== 'sync-players' || !Number.isInteger(body.careerUnverified) || body.careerUnverified <= 0 || !known(source, path => gapSource(path) === source, source === 'espn-career-stats' ? 200 : 503)) return reject('Unexpected career source gap')
    gaps.push(source)
  }
  for (const row of providers.filter(row => row.warning)) {
    const match = /^\[sync-players\] career [0-9a-f-]{36}: (.+)$/.exec(row.warning)
    if (row.invocation !== outcome.invocation_key || row.function !== outcome.function_name || outcome.function_name !== 'sync-players' || !match || !gaps.some(gap => careerSources.includes(gap))) return reject('Unexpected career worker warning')
    const parts = match[1].split('; ')
    if (parts.pop() !== 'NBA career base is unverified') return reject('Unexpected career worker exception')
    const expected = { 'ESPN lookup 503': 'espn-career-search', 'ESPN athlete biography 503': 'espn-career-biography', 'NBA career profile 503': 'nba-career-profile' }
    if (parts.some(part => !expected[part] || !gaps.includes(expected[part]))) return reject('Unattributed career worker exception')
  }
  if (providers.some(row => row.unavailable && !known(row.unavailable.source, path => path === new URL(row.transport).pathname, row.status))) return reject('Invalid provider gap receipt')
  if (providers.some(row => row.unavailable && !gaps.some(gap => gap.startsWith('fantasypros:') ? row.unavailable.source === 'fantasypros-projections' : gap === row.unavailable.source))) return reject('Unaccounted provider gap')
  return { kind: gaps.length ? 'known-source-gap' : 'supported-success', gaps }
}

export function draftFailure(year, origin) {
  return `Could not load a complete ${year} NBA draft board. nba.com: Could not load a complete ${year} NBA draft board from NBA.com. ${origin}/nba/news/${year}-nba-draft-order: NBA.com 503; ${origin}/nba/draft/${year}: NBA.com 503; stats.nba.com: NBA Stats API 503`
}

export function fidelityPass(fidelity) {
  try { return reconciledFidelityPass(fidelity) } catch { return false }
}

function reconciledFidelityPass(fidelity) {
  return fidelity?.version === 2 && inventoryPass(fidelity) && fidelity.catalogVerified === true && verifyCronCatalog(fidelity.catalog) &&
    Object.keys(fidelity.counts ?? {}).length > 0 &&
    Object.entries(fidelity.counts).every(([name, count]) => fidelity.catalog.some(job => job.jobname === name) && Number.isInteger(count) && count > 0) && fidelity.verified === true && fidelity.reconciled === true &&
    Array.isArray(fidelity.outcomes) && fidelity.outcomes.length > 0 &&
    fidelity.outcomes.every(row => {
      const actual = classifyOutcome(row.outcome, { providers: row.providers, at: Date.parse(row.at), draftAvailableAt: row.draftAvailableAt })
      return actual.kind !== 'unexpected' && JSON.stringify(actual) === JSON.stringify(row.classification)
    }) &&
    new Set(fidelity.outcomes.map(row => `${row.phase}:${row.outcome.invocation_key}`)).size === fidelity.outcomes.length &&
    fidelity.outcomes.every(row => row.outcome.invocation_key) &&
    fidelity.unexpected?.length === 0
}

export function catalogIdentity(catalog) {
  return hash(JSON.stringify(catalog.map(row => [row.jobname, row.schedule, row.command]).sort((a, b) => a[0].localeCompare(b[0]))))
}

function inventoryPass(fidelity) {
  if (!Array.isArray(fidelity.phases) || !fidelity.phases.length || !Array.isArray(fidelity.catalog) || !Array.isArray(fidelity.outcomes)) return false
  const jobs = new Set(fidelity.catalog.map(row => row.jobname))
  if (jobs.size !== fidelity.catalog.length) return false
  const catalogHash = catalogIdentity(fidelity.catalog)
  const expected = new Map(), phaseIds = new Set(), counts = {}
  for (const phase of fidelity.phases) {
    if (typeof phase.phase !== 'string' || !phase.phase || phaseIds.has(phase.phase) || phase.catalogHash !== catalogHash) return false
    phaseIds.add(phase.phase)
    if (!Number.isSafeInteger(phase.before) || phase.before < 0 || !Number.isSafeInteger(phase.through) || phase.through < phase.before ||
      !Number.isSafeInteger(phase.nativeCount) || phase.nativeCount < 0 || !Array.isArray(phase.invocations) || phase.invocations.length !== phase.nativeCount ||
      !phase.counts || typeof phase.counts !== 'object' || Array.isArray(phase.counts)) return false
    let previous = phase.before
    for (const row of phase.invocations) {
      if (!Number.isSafeInteger(row.id) || row.id <= previous || row.id > phase.through || typeof row.invocation_key !== 'string' || !row.invocation_key || typeof row.function_name !== 'string' || !row.function_name) return false
      previous = row.id
      const key = `${phase.phase}:${row.invocation_key}`
      if (expected.has(key)) return false
      expected.set(key, row)
    }
    if (previous !== phase.through) return false
    for (const [name, count] of Object.entries(phase.counts)) {
      if (!jobs.has(name) || !Number.isSafeInteger(count) || count <= 0) return false
      counts[name] = (counts[name] ?? 0) + count
    }
  }
  if (expected.size !== fidelity.outcomes.length) return false
  for (const row of fidelity.outcomes) {
    const key = `${row.phase}:${row.outcome.invocation_key}`
    const native = expected.get(key)
    if (!native || Number(row.outcome.id) !== native.id || row.outcome.function_name !== native.function_name) return false
    expected.delete(key)
  }
  const ordered = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  return expected.size === 0 && ordered(counts) === ordered(fidelity.counts) && ordered(counts) === ordered(fidelity.coverage?.invoked)
}

export function rookiePickOrder(order, round, format = 'linear') {
  if (!['linear', 'snake'].includes(format) || !Number.isInteger(round) || round < 1) throw new Error('Invalid rookie draft order')
  return format === 'snake' && round % 2 === 0 ? [...order].reverse() : [...order]
}

export function rookieOrder(members, standings, seed = null) {
  return members.map(memberId => {
    const latest = standings.filter(row => row.member_id === memberId).sort((a, b) => b.week_number - a.week_number)[0]
    const games = Math.max(Number(latest?.wins ?? 0) + Number(latest?.losses ?? 0) + Number(latest?.ties ?? 0), 1)
    const tie = seed ? createHash('md5').update(seed + memberId).digest('hex') : memberId
    return { memberId, hasStandings: latest ? 1 : 0, rate: (Number(latest?.wins ?? 0) + 0.5 * Number(latest?.ties ?? 0)) / games, points: Number(latest?.points_for ?? 0) / games, tie }
  }).sort((a, b) => b.hasStandings - a.hasStandings || a.rate - b.rate || b.points - a.points || a.tie.localeCompare(b.tie) || a.memberId.localeCompare(b.memberId)).map(row => row.memberId)
}
