import { productionJobs } from './cron.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { originUrl } from './common.mjs'
import { catalogIdentity, classifyOutcome, draftFailure, fidelityPass } from './official-outcomes.mjs'
import { fantasyPaths, fantasyTypes, providerTransport, unavailableResponse } from './provider-transport.mjs'

const at = Date.parse('2024-10-23T12:00:00.000Z')
const timestamp = new Date(at).toISOString()
const hash = value => createHash('sha256').update(value).digest('hex')

function outcome(functionName = 'sync-rankings', overrides = {}) {
  return {
    id: 1, invocation_key: 'invocation-1', function_name: functionName,
    status_code: 500, worker_status: 'failed', sync_status: 'failed',
    sync_error: 'Rankings fetch 503', content: JSON.stringify({ error: 'Internal server error' }),
    providerOrigin: originUrl('replay'), ...overrides,
  }
}

function receipt(worker, source, original, overrides = {}) {
  const unavailable = unavailableResponse(source, at)
  const payload = source === 'espn-injury-observations'
    ? { injuries: [{ injuries: [] }], unavailable }
    : source === 'nba-draft-before-publication'
      ? { error: 'Complete pinned draft board unavailable before declared replay availability', unavailable }
      : { unavailable }
  const row = {
    invocation: worker.invocation_key, function: worker.function_name,
    requestId: `request-${source}-${original}`, original,
    transport: providerTransport(original).href, method: 'GET', at: timestamp,
    status: 503, unavailable, bodySha256: hash(JSON.stringify(payload)), ...overrides,
  }
  return { ...row, originReceipt: {
    requestId: row.requestId, transport: row.transport, method: row.method,
    at: row.at, status: row.status, bodySha256: row.bodySha256, unavailable: structuredClone(row.unavailable),
  } }
}

function rankingCase() {
  const worker = outcome()
  return { worker, providers: [receipt(worker, 'hashtag-rankings', `${originUrl('replay')}/fantasy-basketball-dynasty-rankings`)] }
}

function classify(worker, providers = []) {
  return classifyOutcome(worker, { at, providers })
}

test('only the exact attributed rankings source gap passes', () => {
  const { worker, providers } = rankingCase()
  assert.deepEqual(classify(worker, providers), { kind: 'known-source-gap', gaps: ['hashtag-rankings'] })
  assert.equal(classify(worker).kind, 'unexpected')
  assert.equal(classify({ ...worker, sync_error: 'Only loopback targets are allowed' }, providers).kind, 'unexpected')
  assert.equal(classify({ ...worker, sync_error: 'Injected unrelated database fault' }, providers).kind, 'unexpected')
})

test('old generic loopback failures fail for every previously exempt worker', () => {
  for (const functionName of ['sync-rankings', 'sync-projections', 'sync-sleeper-projections']) {
    const worker = outcome(functionName, { sync_error: 'Only loopback targets are allowed' })
    assert.equal(classify(worker).kind, 'unexpected', functionName)
  }
})

test('provider gap evidence fails closed when any required link changes', () => {
  const mutations = {
    invocation: row => { row.invocation = 'other-invocation' },
    function: row => { row.function = 'sync-players' },
    request: row => { row.originReceipt.requestId = 'other-request' },
    route: row => { row.transport = `${originUrl('replay')}/unrelated` },
    original: row => { row.original = 'https://untrusted.example/fantasy-basketball-dynasty-rankings' },
    malformedOriginal: row => { row.original = 'not a URL' },
    malformedTransport: row => { row.transport = 'not a URL' },
    origin: row => { row.transport = 'http://127.0.0.1:1/fantasy-basketball-dynasty-rankings' },
    method: row => { row.method = 'POST' },
    status: row => { row.status = 502 },
    time: row => { row.at = '2024-10-23T12:01:00.000Z' },
    body: row => { row.bodySha256 = hash('unrelated failure') },
    policy: row => { row.unavailable.policy = 'unknown-policy' },
    source: row => { row.unavailable.source = 'sleeper-projections' },
    missingOrigin: row => { delete row.originReceipt },
    originBody: row => { row.originReceipt.bodySha256 = hash('tampered') },
    transportFailure: row => { row.error = 'Injected transport fault' },
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    const { worker, providers } = rankingCase()
    mutate(providers[0])
    assert.equal(classify(worker, providers).kind, 'unexpected', name)
  }
})

test('a valid historical response cannot excuse a later provider fault', () => {
  const { worker, providers } = rankingCase()
  const failed = { ...structuredClone(providers[0]), requestId: 'retry-failed', error: 'Injected worker fault' }
  assert.equal(classify(worker, [...providers, failed]).kind, 'unexpected')
})

test('player sync keeps identity gaps separate from attributed injury warnings', () => {
  const failure = 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503'
  const worker = outcome('sync-players', { sync_error: failure, content: JSON.stringify({ failure, injuryWarnings: 0 }) })
  const identities = receipt(worker, 'sleeper-identities', `${originUrl('replay')}/sleeper/players/nba`)
  assert.deepEqual(classify(worker, [identities]), { kind: 'known-source-gap', gaps: ['sleeper-identities'] })
  const warned = { ...worker, content: JSON.stringify({ failure, injuryWarnings: 1 }) }
  assert.equal(classify(warned, [identities]).kind, 'unexpected')
  const injury = receipt(worker, 'espn-injury-observations', `${originUrl('replay')}/espn/injuries`, { status: 200 })
  assert.deepEqual(classify(warned, [identities, injury]), { kind: 'known-source-gap', gaps: ['sleeper-identities', 'espn-injury-observations'] })
  assert.equal(classify(worker, [identities, injury]).kind, 'unexpected')
  for (const warning of [undefined, 2, -1, '1']) {
    assert.equal(classify({ ...worker, content: JSON.stringify({ failure, injuryWarnings: warning }) }, [identities, injury]).kind, 'unexpected')
  }
  const unrelated = structuredClone(injury)
  unrelated.invocation = 'other-worker'
  assert.equal(classify(warned, [identities, unrelated]).kind, 'unexpected')
  const parseFault = { ...injury, error: 'Injected injury parser exception' }
  assert.equal(classify(warned, [identities, parseFault]).kind, 'unexpected')
  assert.equal(classify({ ...warned, sync_error: `${failure}; injuries: Injected parser exception` }, [identities, injury]).kind, 'unexpected')
  assert.equal(classify({ ...worker, error_message: 'Injected unrelated invocation fault' }, [identities]).kind, 'unexpected')
})

test('draft source absence requires the full native failure before declared availability', () => {
  const origin = originUrl('replay')
  const worker = outcome('sync-draft-order', { sync_error: draftFailure(2024, origin) })
  const paths = [
    '/nba/news/2024-nba-draft-order', '/nba/draft/2024',
    '/stats/stats/drafthistory?LeagueID=00&Season=2024&RoundNum=&RoundPick=&TeamID=0&Overall_Pick=&SeasonType=',
  ]
  const providers = paths.map(path => receipt(worker, 'nba-draft-before-publication', `${origin}${path}`))
  const evidence = { at, providers, draftAvailableAt: '2024-10-24T00:00:00.000Z' }
  assert.deepEqual(classifyOutcome(worker, evidence), { kind: 'known-source-gap', gaps: ['nba-draft-before-publication'] })
  assert.equal(classifyOutcome(worker, { ...evidence, draftAvailableAt: timestamp }).kind, 'unexpected')
  assert.equal(classifyOutcome({ ...worker, sync_error: 'Could not load draft board: 503' }, evidence).kind, 'unexpected')
  assert.equal(classifyOutcome({ ...worker, sync_error: `${worker.sync_error}; injected fault` }, evidence).kind, 'unexpected')
  const wrongRoute = structuredClone(providers)
  wrongRoute[2].transport = `${origin}/stats/stats/unpinned`
  assert.equal(classifyOutcome(worker, { ...evidence, providers: wrongRoute }).kind, 'unexpected')
})

test('player career source gaps require independent exact receipts and unverified careers', () => {
  const failure = 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503'
  const worker = outcome('sync-players', { sync_error: failure, content: JSON.stringify({ failure, injuryWarnings: 0, careerUnverified: 4 }) })
  const identities = receipt(worker, 'sleeper-identities', `${originUrl('replay')}/sleeper/players/nba`)
  const sources = [
    { source: 'espn-career-stats', path: '/career/athletes/123/stats?seasontype=2', status: 200 },
    { source: 'espn-career-biography', path: '/career/athletes/123', status: 503 },
    { source: 'espn-career-search', path: '/career-search?query=Example+Player&type=player&limit=50', status: 503 },
    { source: 'nba-career-profile', path: '/nba/player/123', status: 503 },
  ]
  for (const { source, path, status } of sources) {
    const career = receipt(worker, source, `${originUrl('replay')}${path}`, { status })
    assert.deepEqual(classify(worker, [identities, career]), { kind: 'known-source-gap', gaps: ['sleeper-identities', source] })
    for (const count of [undefined, 0, -1, 1.5, '1']) {
      const body = { failure, injuryWarnings: 0, careerUnverified: count }
      assert.equal(classify({ ...worker, content: JSON.stringify(body) }, [identities, career]).kind, 'unexpected', `${source}:${count}`)
    }
    const mutations = [
      row => { row.invocation = 'other-worker' },
      row => { row.status = status === 200 ? 503 : 200; row.originReceipt.status = row.status },
      row => { row.transport = `${originUrl('replay')}/career/unsupported`; row.original = row.transport; row.originReceipt.transport = row.transport },
      row => { row.transport += row.transport.includes('?') ? '&extra=1' : '?extra=1'; row.original = row.transport; row.originReceipt.transport = row.transport },
      row => { row.bodySha256 = hash('{"invented":true}'); row.originReceipt.bodySha256 = row.bodySha256 },
      row => { row.error = 'Injected career worker error' },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(career)
      mutate(changed)
      assert.equal(classify(worker, [identities, changed]).kind, 'unexpected', source)
    }
  }
  const providers = sources.map(({ source, path, status }) => receipt(worker, source, `${originUrl('replay')}${path}`, { status }))
  assert.deepEqual(classify(worker, [identities, ...providers]), { kind: 'known-source-gap', gaps: ['sleeper-identities', ...sources.map(({ source }) => source)] })
})

function projectionsCase() {
  const worker = outcome('sync-projections', {
    status_code: 200, worker_status: 'success', sync_status: 'success', sync_error: null,
    content: JSON.stringify({ ok: true, internalFallback: 3, fantasypros: fantasyTypes.map(projectionType => ({
      projectionType, status: 'failed', rows: 0, matched: 0, unmatched: 0,
      error: `FantasyPros ${projectionType} fetch failed with HTTP 503`,
    })) }),
  })
  const providers = fantasyPaths.map(file => receipt(worker, 'fantasypros-projections', `https://www.fantasypros.com/nba/projections/${file}`))
  return { worker, providers }
}

test('projection 200 responses require exact source gaps for all three subresults', () => {
  const { worker, providers } = projectionsCase()
  assert.deepEqual(classify(worker, providers), { kind: 'known-source-gap', gaps: fantasyTypes.map(type => `fantasypros:${type}`) })
  assert.equal(classify(worker, providers.slice(1)).kind, 'unexpected')
  for (const error of ['Only loopback targets are allowed', 'Injected unrelated worker fault', 'Database insert failed']) {
    const body = JSON.parse(worker.content)
    body.fantasypros[1].error = error
    assert.equal(classify({ ...worker, content: JSON.stringify(body) }, providers).kind, 'unexpected', error)
  }
  const body = JSON.parse(worker.content)
  body.fantasypros[0].status = 'skipped'
  assert.equal(classify({ ...worker, content: JSON.stringify(body) }, providers).kind, 'unexpected')
  body.fantasypros[0] = { projectionType: 'daily', status: 'success', rows: 10, matched: 10, unmatched: 0 }
  assert.equal(classify({ ...worker, content: JSON.stringify(body) }, providers).kind, 'unexpected')
})

test('supported worker success requires durable success and sound transport', () => {
  const worker = outcome('sync-scores', { status_code: 200, worker_status: 'success', sync_status: 'success', sync_error: null, content: '{"ok":true}' })
  assert.deepEqual(classify(worker), { kind: 'supported-success', gaps: [] })
  for (const overrides of [{ invocation_key: null }, { sync_status: 'failed' }, { sync_error: 'Injected worker fault' }, { error_message: 'Injected invocation fault' }, { timed_out: true }, { error_msg: 'timeout' }, { content: '{' }, { content: '{"ok":false,"queued":[{"status":"failed"}]}' }]) {
    assert.equal(classify({ ...worker, ...overrides }).kind, 'unexpected')
  }
})

test('fidelity acceptance recomputes classifications and rejects duplicated history', () => {
  const { worker, providers } = rankingCase()
  const row = { phase: 'opening', at: timestamp, outcome: worker, providers, classification: classify(worker, providers) }
  const fidelity = { version: 2, coverage: { invoked: { 'nba-live-poll': 1 } }, phases: [{ phase: 'opening', catalogHash: catalogIdentity(productionJobs), before: 0, through: 1, nativeCount: 1, invocations: [{ id: 1, invocation_key: worker.invocation_key, function_name: worker.function_name }], counts: { 'nba-live-poll': 1 } }], catalogVerified: true, catalog: productionJobs, counts: { 'nba-live-poll': 1 }, verified: true, reconciled: true, outcomes: [row], unexpected: [] }
  assert.equal(fidelityPass(fidelity), true)
  const forged = structuredClone(fidelity)
  forged.outcomes[0].outcome.sync_error = 'Only loopback targets are allowed'
  assert.equal(fidelityPass(forged), false)
  const relabeled = structuredClone(fidelity)
  relabeled.outcomes[0].classification = { kind: 'supported-success', gaps: [] }
  assert.equal(fidelityPass(relabeled), false)
  assert.equal(fidelityPass({ ...fidelity, outcomes: [row, row] }), false)
  assert.equal(fidelityPass({ ...fidelity, outcomes: [] }), false)
  assert.equal(fidelityPass({ ...fidelity, reconciled: false }), false)
  assert.equal(fidelityPass({ ...fidelity, unexpected: [{ error: 'retained failure' }] }), false)
})

test('native phase inventories prevent lost outcomes and mismatched command counts', () => {
  const make = () => {
    const counts = { 'nba-sync-schedule': 2 }
    const outcomes = [1, 2].map(id => ({ phase: 'opening', at: timestamp, outcome: outcome('sync-schedule', { id, invocation_key: `worker-${id}`, status_code: 200, worker_status: 'success', sync_status: 'success', sync_error: null, content: '{"ok":true}' }), providers: [], classification: { kind: 'supported-success', gaps: [] } }))
    return { version: 2, catalogVerified: true, catalog: productionJobs, counts, coverage: { invoked: { ...counts } }, verified: true, reconciled: true, unexpected: [], outcomes,
      phases: [{ phase: 'opening', catalogHash: catalogIdentity(productionJobs), before: 0, through: 2, nativeCount: 2, invocations: outcomes.map(row => ({ id: row.outcome.id, invocation_key: row.outcome.invocation_key, function_name: row.outcome.function_name })), counts: { ...counts } }] }
  }
  assert.equal(fidelityPass(make()), true)
  const corruptions = [
    value => value.outcomes.pop(),
    value => value.outcomes.push({ ...value.outcomes[0], phase: 'extra' }),
    value => { value.outcomes[0].phase = 'restored' },
    value => { value.outcomes[0].outcome.id = 999 },
    value => { value.outcomes[0].outcome.function_name = 'other-worker' },
    value => value.phases[0].invocations.pop(),
    value => { value.phases[0].nativeCount = 999 },
    value => { value.phases[0].through = 999 },
    value => { value.phases[0].catalogHash = 'wrong' },
    value => { value.counts['nba-sync-schedule'] = 999 },
    value => { value.phases[0].counts['nba-sync-schedule'] = 999 },
    value => { value.coverage.invoked['nba-sync-schedule'] = 999 },
    value => value.phases.push(value.phases[0]),
    value => { value.version = 1 },
  ]
  for (const mutate of corruptions) { const value = make(); mutate(value); assert.equal(fidelityPass(value), false) }
  const restored = make()
  restored.phases[0].nativeCount = 1
  restored.phases[0].through = 1
  restored.phases[0].invocations.pop()
  restored.phases[0].counts['nba-sync-schedule'] = 1
  restored.outcomes[1].phase = 'restored'
  restored.outcomes[1].outcome.id = 1
  restored.phases.push({ phase: 'restored', catalogHash: catalogIdentity(productionJobs), before: 0, through: 1, nativeCount: 1, invocations: [{ id: 1, invocation_key: 'worker-2', function_name: 'sync-schedule' }], counts: { 'nba-sync-schedule': 1 } })
  assert.equal(fidelityPass(restored), true)
})

test('a known career gap cannot conceal an unrelated caught worker exception', () => {
  const failure = 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503'
  const worker = outcome('sync-players', { sync_error: failure, content: JSON.stringify({ failure, injuryWarnings: 0, careerUnverified: 1 }) })
  const providers = [receipt(worker, 'sleeper-identities', `${originUrl('replay')}/sleeper/players/nba`), receipt(worker, 'espn-career-stats', `${originUrl('replay')}/career/athletes/123/stats?seasontype=2`, { status: 200 })]
  const warning = { invocation: worker.invocation_key, function: worker.function_name, at: timestamp, warning: '[sync-players] career 00000000-0000-0000-0000-000000000001: NBA career base is unverified' }
  assert.equal(classify(worker, [...providers, warning]).kind, 'known-source-gap')
  for (const message of ['Injected unrelated worker fault', 'Database insert failed', 'Only loopback targets are allowed; NBA career base is unverified']) {
    assert.equal(classify(worker, [...providers, { ...warning, warning: `[sync-players] career 00000000-0000-0000-0000-000000000001: ${message}` }]).kind, 'unexpected')
  }
})
