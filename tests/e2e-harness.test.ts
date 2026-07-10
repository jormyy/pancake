import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseArgs } from './e2e/harness/args.mjs'

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('e2e harness args', () => {
  it('combines CLI flags and environment switches', () => {
    process.argv = [
      'node',
      'tests/e2e/soak.mjs',
      '--seasons=3',
      '--fake-port=4999',
      '--browser-full-sweep=true',
      '--browser-waiver=true',
    ]
    vi.stubEnv('E2E_SEASONS', '8')
    vi.stubEnv('E2E_ENABLE_BROWSER_TRADE', '1')

    const args = parseArgs()

    expect(args.seasons).toBe(3)
    expect(args.fakePort).toBe(4999)
    expect(args.browserFullSweep).toBe(true)
    expect(args.browserWaiver).toBe(true)
    expect(args.browserTrade).toBe(true)
    expect(args.browserPerf).toBe(false)
  })
})

describe('e2e browser scenario registry', () => {
  it('gates every browser flow by the shared season policy', async () => {
    vi.resetModules()
    const smoke = vi.fn(async () => ({ ok: 'smoke' }))
    const auth = vi.fn(async () => ({ ok: 'auth' }))
    const perf = vi.fn(async () => ({ ok: 'perf' }))
    const trade = vi.fn(async () => ({ ok: 'trade' }))

    mockBrowserScenarioModules({ smoke, auth, perf, trade })
    const { runBrowserScenarios } = await import('./e2e/harness/browser-scenarios.mjs')
    const args = {
      browser: true,
      browserFullSweep: true,
      browserAuth: true,
      browserPerf: true,
      browserTrade: true,
      browserWaiver: false,
    }
    const shouldRun = vi.fn(() => false)

    const skipped = await runBrowserScenarios({ args, season: 2, shouldRun })

    expect(smoke).not.toHaveBeenCalled()
    expect(auth).not.toHaveBeenCalled()
    expect(perf).not.toHaveBeenCalled()
    expect(trade).not.toHaveBeenCalled()
    expect(skipped.browserPerfCheck).toBeNull()
    expect(skipped.browserTradeCheck).toBeNull()
    expect(shouldRun).toHaveBeenCalledTimes(4)

    shouldRun.mockReturnValue(true)
    const completed = await runBrowserScenarios({ args, season: 1, shouldRun })

    expect(smoke).toHaveBeenCalledWith({ season: 1, fullSweep: true })
    expect(auth).toHaveBeenCalledWith({ season: 1 })
    expect(perf).toHaveBeenCalledWith({ season: 1 })
    expect(trade).toHaveBeenCalledWith({ season: 1 })
    expect(completed.browserPerfCheck).toEqual({ ok: 'perf' })
    expect(completed.browserTradeCheck).toEqual({ ok: 'trade' })
    expect(completed.browserWaiverCheck).toBeNull()
  })
})

describe('e2e backend scenario registry', () => {
  it('runs enabled scenarios through shared context and collects failures', async () => {
    const { backendScenarioFailures, runBackendScenarios } = await import('./e2e/harness/backend-scenarios.mjs')
    const context = {
      env: { apiBaseUrl: 'http://127.0.0.1' },
      fakePort: 4999,
      leagueId: 'league-1',
      season: 1,
      state: { runId: 'run-1' },
      supabase: { marker: 'db' },
    }
    const runners = {
      assertAuctionBidValidation: vi.fn(async () => ({ ok: 'auction' })),
      assertDraftPushNotification: vi.fn(async () => ({ failures: ['draft push failed'] })),
      assertInjuryStatusFilterScenario: vi.fn(async () => ({ failures: [] })),
      assertLeagueLifecycleScenario: vi.fn(async () => ({ failures: ['league failed'] })),
      assertPlayoffBracketScenario: vi.fn(async () => ({ failures: [] })),
      assertRookieDraftAutoPickScenario: vi.fn(async () => ({ failures: [] })),
      assertSeasonResetScenario: vi.fn(async () => ({ failures: [] })),
      assertStandingsTiebreakerScenario: vi.fn(async () => ({ failures: [] })),
      assertTradeAcceptanceAtomicityScenario: vi.fn(async () => ({ failures: [] })),
      assertTradeVetoScenario: vi.fn(async () => ({ failures: [] })),
      assertWaiverProcessingScenario: vi.fn(async () => ({ failures: [] })),
      assertWeeklyScoringFinalizationScenario: vi.fn(async () => ({ failures: [] })),
      assertCommissionerSettingsScenario: vi.fn(async () => ({ failures: [] })),
    }
    const args = {
      auction: true,
      draftPush: true,
      injuryFilter: true,
      leagueLifecycle: true,
      playoffs: false,
    }
    const shouldRun = vi.fn((_, season) => season === 1)

    const results = await runBackendScenarios({ args, context, runners, shouldRun })

    expect(runners.assertLeagueLifecycleScenario).toHaveBeenCalledWith(context)
    expect(runners.assertAuctionBidValidation).toHaveBeenCalledWith({
      supabase: context.supabase,
      leagueId: context.leagueId,
      season: context.season,
    })
    expect(runners.assertInjuryStatusFilterScenario).toHaveBeenCalledWith({
      supabase: context.supabase,
      env: context.env,
      season: context.season,
      fakePort: context.fakePort,
    })
    expect(runners.assertPlayoffBracketScenario).not.toHaveBeenCalled()
    expect(results.auctionValidation).toEqual({ ok: 'auction' })
    expect(backendScenarioFailures(results)).toEqual(['league failed', 'draft push failed'])
    expect(shouldRun).toHaveBeenCalledTimes(4)
  })
})

describe('e2e harness reporting', () => {
  it('exports report writers for the soak runner', async () => {
    const reporting = await import('./e2e/harness/reporting.mjs')

    expect(reporting.writeCoverageReport).toEqual(expect.any(Function))
    expect(reporting.writeReport).toEqual(expect.any(Function))
  })
})

type ScenarioMocks = {
  auth: ReturnType<typeof vi.fn>
  perf: ReturnType<typeof vi.fn>
  smoke: ReturnType<typeof vi.fn>
  trade: ReturnType<typeof vi.fn>
}

const noopScenario = vi.fn(async () => ({ ok: 'unused' }))

const mockBrowserScenarioModules = ({ auth, perf, smoke, trade }: ScenarioMocks) => {
  vi.doMock('./e2e/browser-smoke.mjs', () => ({ runBrowserSmoke: smoke }))
  vi.doMock('./e2e/browser-auth.mjs', () => ({ runBrowserAuthScenario: auth }))
  vi.doMock('./e2e/browser-perf-smoke.mjs', () => ({ runBrowserPerfSmoke: perf }))
  vi.doMock('./e2e/browser-gameplay.mjs', () => ({ runBrowserGameplayScenario: noopScenario }))
  vi.doMock('./e2e/browser-league-lifecycle.mjs', () => ({ runBrowserLeagueLifecycleScenario: noopScenario }))
  vi.doMock('./e2e/browser-lineup-gameplay.mjs', () => ({
    runBrowserLineupAutoSetScenario: noopScenario,
    runBrowserLineupLockedScenario: noopScenario,
    runBrowserLineupScenario: noopScenario,
  }))
  vi.doMock('./e2e/browser-playoff-gameplay.mjs', () => ({ runBrowserPlayoffChampionScenario: noopScenario }))
  vi.doMock('./e2e/browser-rookie-draft-gameplay.mjs', () => ({ runBrowserRookieDraftAutoPickScenario: noopScenario }))
  vi.doMock('./e2e/browser-waiver-gameplay.mjs', () => ({
    runBrowserWaiverDropScenario: noopScenario,
    runBrowserWaiverIrBlockScenario: noopScenario,
    runBrowserWaiverScenario: noopScenario,
  }))
  vi.doMock('./e2e/browser-trade-acceptance-scenarios.mjs', () => ({
    runBrowserTradeAcceptScenario: noopScenario,
    runBrowserTradeFuturePickAcceptScenario: noopScenario,
    runBrowserTradeFuturePickScenario: noopScenario,
    runBrowserTradeOverflowAcceptScenario: noopScenario,
  }))
  vi.doMock('./e2e/browser-trade-proposal-scenarios.mjs', () => ({
    runBrowserTradePostDeadlineScenario: noopScenario,
    runBrowserTradeScenario: trade,
  }))
  vi.doMock('./e2e/browser-trade-terminal-scenarios.mjs', () => ({
    runBrowserTradeTerminalScenario: noopScenario,
    runBrowserTradeVetoScenario: noopScenario,
  }))
  vi.doMock('./e2e/browser-trade-multi-team.mjs', () => ({
    runBrowserMultiTeamTradeScenario: noopScenario,
  }))
}
