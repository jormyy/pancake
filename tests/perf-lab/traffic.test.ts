import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { trafficBreakdown } from '../../scripts/perf-lab/traffic.mjs'

describe('gateway traffic attribution', () => {
  const row = (url: string, bytesOut: number, type: string) => ({ method: 'GET', url: `https://localhost:57284${url}`, bytesIn: 2, bytesOut, durationMs: 3, status: 200, responseHeaders: { 'content-type': type } })
  it('reconciles asset and endpoint totals without exposing query values', () => {
    const rows = [row('/_expo/a.js', 100, 'text/javascript'), row('/rest/v1/rpc/get_home?token=secret', 50, 'application/json'), row('/assets/head.png', 25, 'image/png'), row('/rest/v1/rpc/get_home?token=second', 30, 'application/json')]
    const result = trafficBreakdown(rows)
    for (const groups of Object.values(result)) {
      expect(groups.reduce((sum, value) => sum + value.requests, 0)).toBe(4)
      expect(groups.reduce((sum, value) => sum + value.bytesDown, 0)).toBe(205)
      expect(groups.reduce((sum, value) => sum + value.bytesUp, 0)).toBe(8)
    }
    expect(result.resourceTypes.find(value => value.id === 'API')?.bytesDown).toBe(80)
    expect(result.endpoints.find(value => value.id === 'GET /rest/v1/rpc/get_home')?.requests).toBe(2)
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('rejects absent byte counters instead of reporting zero', () => {
    expect(() => trafficBreakdown([{ ...row('/', 1, 'text/html'), bytesOut: undefined }])).toThrow('Traffic bytes must be measured')
  })
})

describe('baseline publication', () => {
  it('writes a readable report without claiming unmeasured coverage', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { renderReport } = await import('../../scripts/perf-lab/report.mjs')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-report-'))
    try {
      const options = { evidenceRoot: directory, writeDocs: false }
      const { report } = await renderReport(options)
      expect(report.done).toBe(false)
      expect(report.passed).toBe(0)
      const markdown = await readFile(path.join(directory, 'baseline.md'), 'utf8')
      expect(markdown).toContain('4500930 bytes down')
      expect(markdown).toContain('GET /functions/v1/api/views/home')
      expect(markdown).toContain('JavaScript | 22 | 4123954')
      const archived = JSON.parse(await readFile('scripts/perf-lab/baselines/normal-cache.json', 'utf8'))
      expect(markdown).toContain(archived.source)
      expect(markdown).toContain('Archived cache-enabled baseline')
      expect(report.networkRanking.endpoints).toEqual([])
      const simulation = { captureProfile: 'control', passed: true, days: 2, fidelity: 'production-cadence', gates: Object.fromEntries(['liveTicks', 'overnightFinalization', 'preTipoff', 'waivers', 'tradeProposed', 'tradeCountered', 'tradeAccepted', 'forecasts', 'realtime'].map(key => [key, true])) }
      const controlOptions = { ...options, simulation }
      const control = await renderReport(controlOptions)
      expect(control.report.simulationPassed).toBe(true)
      expect(control.report.fullCapturePassed).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15000)
})

describe('replay request capture', () => {
  it('measures streamed bodies without consuming the caller response', async () => {
    const { measuredFetch } = await import('../../scripts/perf-lab/replay-capture.mjs')
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-fetch-'))
    try {
      const file = path.join(directory, 'requests.jsonl')
      const fetcher = measuredFetch(async () => new Response('answer', { headers: { 'cache-control': 'no-store', 'set-cookie': 'secret' } }), file)
      const response = await fetcher('http://127.0.0.1:57221/rest/v1/example?token=secret', { method: 'POST', body: 'sent', headers: { authorization: 'secret' } })
      expect(await response.text()).toBe('answer')
      await fetcher.flush()
      const text = await readFile(file, 'utf8')
      expect(text).not.toContain('secret')
      expect(JSON.parse(text).startedAt).toEqual(expect.any(Number))
      expect(JSON.parse(text)).toMatchObject({ bytesIn: 4, bytesOut: 6, status: 200, responseHeaders: { 'cache-control': 'no-store' } })
      const broken = measuredFetch(async () => new Response('body'), path.join(directory, 'absent', 'requests.jsonl'))
      await broken('http://127.0.0.1:57221/rest/v1/example')
      await expect(broken.flush()).rejects.toThrow('Replay access capture failed')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('interaction budgets', () => {
  it('attributes a debounced search request to its last keystroke', async () => {
    const { controlContract, interactionMeasurement } = await import('../../scripts/perf-lab/interactions.mjs')
    const control = { ...controlContract({ fill: 'Search players', value: 'AB', cadenceMs: 180 }), id: 'search', window: 'screen/search', startedAt: 100,
      dbMs: 4, dbCalls: 1, dbRows: 2, dbBuffers: 3, renderMutations: 2,
      keystrokes: [{ index: 0, value: 'A', at: 100, window: 'screen/search/key/0' }, { index: 1, value: 'AB', at: 280, window: 'screen/search/key/1' }] }
    const measured = interactionMeasurement(control, [{ window: 'screen/search/key/1', bytesIn: 10, bytesOut: 200 }], 600, [{ query: 'AB', at: 580, ready: true }])
    expect(measured.requests).toBe(1)
    expect(measured.keystrokes[0].requests).toBe(0)
    expect(measured.keystrokes[0].resultsMs).toBe(null)
    expect(measured.keystrokes[1]).toMatchObject({ requests: 1, bytesDown: 200, resultsMs: 300 })
    expect(measured.budgetPassed).toBe(true)
    expect(interactionMeasurement(control, [], 600, []).budgetPassed).toBe(false)
    expect(interactionMeasurement({ ...control, dbMs: undefined }, [], 600, [{ query: 'AB', at: 580, ready: true }]).budgetPassed).toBe(false)
  })
})

describe('control render observations', () => {
  it('requires a completed sequence and every control metric before counting its preparatory actions', async () => {
    const { sequenceControlProved } = await import('../../scripts/perf-lab/report.mjs')
    const control = { actionCompleted: true, requests: 1, bytesDown: 2, resultsMs: 3, dbMs: 4, dbCalls: 5, dbRows: 6, dbBuffers: 7, renderMutations: 8 }
    expect(sequenceControlProved(control, { passed: true })).toBe(true)
    expect(sequenceControlProved(control, { passed: false })).toBe(false)
    expect(sequenceControlProved({ ...control, dbMs: undefined }, { passed: true })).toBe(false)
    expect(sequenceControlProved({ ...control, actionCompleted: false }, { passed: true })).toBe(false)
  })
  it('reports only DOM changes inside the control interval and keeps missing evidence unknown', async () => {
    const { renderSummary } = await import('../../scripts/perf-lab/control-observer.mjs')
    expect(renderSummary([{ at: 1, scope: 'old' }, { at: 10, scope: 'players' }, { at: 11, scope: 'players' }, { at: 12, scope: 'filters' }], 10, 12))
      .toEqual({ renderMutations: 3, renderScopes: ['filters', 'players'] })
    expect(renderSummary(null, 10, 12)).toEqual({ renderMutations: null, renderScopes: null })
  })
})

describe('player filter inventory', () => {
  it('includes every declared single-choice value and NBA team', async () => {
    const { readFile } = await import('node:fs/promises')
    const scenarios = JSON.parse(await readFile('scripts/perf-lab/scenarios.json', 'utf8'))
    const source = await readFile('app/(tabs)/players.tsx', 'utf8')
    for (const [name, label] of [['POSITIONS', 'Position'], ['AVAILABILITY_FILTERS', 'Availability'], ['HEALTH_FILTERS', 'Health'], ['PLAYING_FILTERS', 'Game today'], ['CLASS_FILTERS', 'Experience']]) {
      const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source)?.[1] ?? ''
      const labels = [...block.matchAll(/label: '([^']+)'/g)].map(match => match[1])
      expect(labels.length).toBeGreaterThan(1)
      expect(scenarios.filter((scenario: { steps: { action: { dialog?: string; tap?: string } }[] }) => scenario.steps[0]?.action.dialog === label)
        .map((scenario: { steps: { action: { tap?: string } }[] }) => scenario.steps[0].action.tap)).toEqual(labels)
    }
    const { NBA_TEAM_OPTIONS } = await import('../../constants/nba')
    expect(scenarios.filter((scenario: { name: string }) => scenario.name.startsWith('perf-filter-team-')).map((scenario: { steps: { action: { tap: string } }[] }) => scenario.steps[0].action.tap)).toEqual(NBA_TEAM_OPTIONS.map(option => option.label))
  })
})

describe('frozen batch accumulation', () => {
  it('retains only matching workloads and keeps historical artifact paths distinct', async () => {
    const { accumulatedReceipts } = await import('../../scripts/perf-lab/report.mjs')
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-history-'))
    try {
      const run = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      await mkdir(path.join(directory, 'history', run), { recursive: true })
      await writeFile(path.join(directory, 'history', run, 'walk.json'), JSON.stringify([
        { id: 'kept', fingerprint: 'frozen', webkit: { har: 'screen/screen.har' } }, { id: 'stale', fingerprint: 'old' },
      ]))
      const result = await accumulatedReceipts(directory, [{ id: 'new', fingerprint: 'frozen' }], 'frozen')
      expect(result.map((row: { id: string }) => row.id)).toEqual(['kept', 'new'])
      expect(result[0].webkit.har).toBe(`history/${run}/screen/screen.har`)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('network cost ranking', () => {
  it('keeps archived release costs out of the current baseline', async () => {
    const { renderReport } = await import('../../scripts/perf-lab/report.mjs')
    const { report } = await renderReport({ writeDocs: false })
    expect(report.ranking).toEqual([])
    expect(report.networkRanking.endpoints).toEqual([])
    expect(report.archivedColdRanking.length).toBeGreaterThanOrEqual(39)
    expect(report.archivedColdRanking.some((row: { id: string }) => row.id.startsWith('interaction.perf-filter-'))).toBe(true)
  })
  it('ranks total traffic cost instead of a single expensive request', async () => {
    const { rankTraffic } = await import('../../scripts/perf-lab/traffic.mjs')
    const breakdown = { endpoints: [{ id: 'rare', requests: 1, bytesDown: 100, bytesUp: 0, durationMs: 1 }, { id: 'frequent', requests: 10, bytesDown: 200, bytesUp: 0, durationMs: 10 }], resourceTypes: [] }
    const ranked = rankTraffic([{ breakdown }])
    expect(ranked.endpoints.map((row: { id: string }) => row.id)).toEqual(['frequent', 'rare'])
    expect(ranked.endpoints[0].bytesPerRequest).toBe(20)
  })
})

describe('headshot fixture boundary', () => {
  it('only maps the production headshot asset shape to a frozen fixture', async () => {
    const { headshotId } = await import('../../scripts/perf-lab/headshots.mjs')
    expect(headshotId('https://cdn.nba.com/headshots/nba/latest/260x190/1630639.png')).toBe('1630639')
    expect(headshotId('https://cdn.nba.com/headshots/nba/latest/260x190/1630639.png?key=secret')).toBe(null)
    expect(headshotId('https://example.com/headshots/nba/latest/260x190/1630639.png')).toBe(null)
  })
})

describe('evidence archive transfer', () => {
  it('archives completed evidence before removing stale current-run artifacts', async () => {
    const { archiveEvidence } = await import('../../scripts/perf-lab/evidence.mjs')
    const { readFile, readdir } = await import('node:fs/promises')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-archive-'))
    const runId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    try {
      await writeFile(path.join(directory, 'database-run.json'), JSON.stringify({ runId }))
      await writeFile(path.join(directory, 'old-image.png'), 'old')
      await writeFile(path.join(directory, 'coverage.json'), '{}')
      await archiveEvidence(directory)
      expect((await readdir(directory)).sort()).toEqual(['coverage.json', 'history'])
      expect(await readFile(path.join(directory, 'history', runId, 'old-image.png'), 'utf8')).toBe('old')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects path escapes and links before extraction', async () => {
    const { verifyArchivePaths } = await import('../../scripts/perf-lab/transfer.mjs')
    expect(() => verifyArchivePaths('./walk.json\n./screen/first.png', '-rw------- file\n-rw------- other')).not.toThrow()
    expect(() => verifyArchivePaths('../escape', '-rw------- file')).toThrow('escapes')
    expect(() => verifyArchivePaths('./link', 'lrwx------ link')).toThrow('link or special')
  })
  it('sends current evidence and history that the receiver does not have', async () => {
    const { transferEntries } = await import('../../scripts/perf-lab/transfer.mjs')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-transfer-'))
    const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const second = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    try {
      await mkdir(path.join(directory, 'history', first), { recursive: true })
      await mkdir(path.join(directory, 'history', second), { recursive: true })
      await writeFile(path.join(directory, 'walk.json'), '[]')
      expect(await transferEntries(directory, [first])).toEqual(['./walk.json', `./history/${second}`])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('removes old screenshots before a new observation', async () => {
    const { prepareObservationDirectory } = await import('../../scripts/perf-lab/walk.mjs')
    const { readdir } = await import('node:fs/promises')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-observation-'))
    try {
      await writeFile(path.join(directory, 'settled.png'), 'old image')
      await prepareObservationDirectory(directory)
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('control route mapping', () => {
  it('keeps later composer controls on the destination screen', async () => {
    const { controlInventory } = await import('../../scripts/perf-lab/interactions.mjs')
    const controls = controlInventory([{ name: 'trade', from: '/trades', steps: [
      { action: { open: '/propose-trade' }, expected: { route: '/propose-trade' } },
      { action: { tap: 'Analyze trade' }, expected: { text: 'Analysis' } },
    ] }])
    expect(controls[1].route).toBe('/propose-trade')
  })
})

describe('repeated controls', () => {
  it('maps parameterized row buttons without covering unrelated controls', async () => {
    const { controlLabelMatches } = await import('../../scripts/perf-lab/report.mjs')
    expect(controlLabelMatches('tap', 'Open {{freeAgent.display_name}}', 'Open Jalen Reed')).toBe(true)
    expect(controlLabelMatches('tapPrefix', 'Select ', 'Select Jalen Reed for trade')).toBe(true)
    expect(controlLabelMatches('tap', 'Open {{freeAgent.display_name}}', 'Drop Jalen Reed')).toBe(false)
    expect(controlLabelMatches('tap', 'Save', 'Save settings')).toBe(false)
  })
  it('keeps control evidence on its screen and tab', async () => {
    const { sameControlSurface } = await import('../../scripts/perf-lab/report.mjs')
    expect(sameControlSurface('/player/:id', '/player/{{freeAgent.id}}')).toBe(true)
    expect(sameControlSurface('/players?section=news', '/players?section=waivers')).toBe(false)
    expect(sameControlSurface('/players', '/trades')).toBe(false)
  })
})

describe('identity conflict evidence', () => {
  it('requires both old providers and the imported ESPN identity on one surviving owner', async () => {
    const { identityPairResults } = await import('../../scripts/perf-lab/identity-diagnostics.mjs')
    const pairs = [{ name: 'Example', nbaId: '1', sleeperId: '2', espnId: '3', candidateIds: ['a', 'b'] }]
    expect(identityPairResults(pairs, [{ id: 'a', nba_id: '1' }, { id: 'b', sleeper_id: '2' }])[0].merged).toBe(false)
    expect(identityPairResults(pairs, [{ id: 'a', nba_id: '1', sleeper_id: '2', espn_id: '3' }])[0].merged).toBe(true)
    expect(identityPairResults(pairs, [{ id: 'a', nba_id: '1', sleeper_id: '2' }])[0].merged).toBe(false)
  })
  it('extracts only the reported numeric provider IDs once', async () => {
    const { conflictProviderIds } = await import('../../scripts/perf-lab/identity-diagnostics.mjs')
    expect(conflictProviderIds('espn provider 123: ambiguous identity; espn provider 123: ambiguous identity; espn provider 456: ambiguous identity')).toEqual(['123', '456'])
    expect(conflictProviderIds("espn provider 123'; DROP: ambiguous identity")).toEqual([])
    expect(conflictProviderIds('canceling statement due to lock timeout')).toEqual([])
  })
})
