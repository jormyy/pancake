import process from 'node:process'
import { runBrowserAuthScenario } from './browser-auth.mjs'
import { runBrowserGameplayScenario } from './browser-gameplay.mjs'
import { runBrowserLeagueLifecycleScenario } from './browser-league-lifecycle.mjs'
import {
  runBrowserLineupAutoSetScenario,
  runBrowserLineupLockedScenario,
  runBrowserLineupScenario,
} from './browser-lineup-gameplay.mjs'
import { runBrowserPerfSmoke } from './browser-perf-smoke.mjs'
import { runBrowserPlayoffChampionScenario } from './browser-playoff-gameplay.mjs'
import { runBrowserRookieDraftAutoPickScenario } from './browser-rookie-draft-gameplay.mjs'
import { runBrowserSmoke } from './browser-smoke.mjs'
import {
  runBrowserWaiverDropScenario,
  runBrowserWaiverIrBlockScenario,
  runBrowserWaiverScenario,
} from './browser-waiver-gameplay.mjs'
import { TRADE_SCENARIOS } from './trade-scenario-registry.mjs'

const STANDARD_BROWSER_SCENARIOS = [
  { id: 'smoke', flag: 'browser', resultKey: 'browserCheck', evidenceId: 'browser.smoke', ciTier: 'fast', requiresSeed: true, run: ({ args, season }) => runBrowserSmoke({ season, fullSweep: args.browserFullSweep }) },
  { id: 'auth', flag: 'browserAuth', resultKey: 'browserAuthCheck', evidenceId: 'browser.auth', ciTier: 'fast', requiresSeed: false, run: ({ season }) => runBrowserAuthScenario({ season }) },
  { id: 'performance', flag: 'browserPerf', resultKey: 'browserPerfCheck', evidenceId: 'browser.performance', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserPerfSmoke({ season }) },
  { id: 'auction', flag: 'browserGameplay', resultKey: 'browserGameplayCheck', evidenceId: 'browser.auction', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserGameplayScenario({ season }) },
  { id: 'lineup', flag: 'browserLineup', resultKey: 'browserLineupCheck', evidenceId: 'browser.lineup', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserLineupScenario({ season }) },
  { id: 'lineup-auto-set', flag: 'browserLineupAutoSet', resultKey: 'browserLineupAutoSetCheck', evidenceId: 'browser.lineup_auto_set', ciTier: 'release', requiresSeed: true, run: ({ season }) => runBrowserLineupAutoSetScenario({ season }) },
  { id: 'lineup-locked', flag: 'browserLineupLocked', resultKey: 'browserLineupLockedCheck', evidenceId: 'browser.lineup_locked', ciTier: 'release', requiresSeed: true, run: ({ season }) => runBrowserLineupLockedScenario({ season }) },
  { id: 'playoffs', flag: 'browserPlayoff', resultKey: 'browserPlayoffCheck', evidenceId: 'browser.playoffs', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserPlayoffChampionScenario({ season }) },
  { id: 'rookie-draft', flag: 'browserRookieDraft', resultKey: 'browserRookieDraftCheck', evidenceId: 'browser.rookie_draft', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserRookieDraftAutoPickScenario({ season }) },
  { id: 'waiver', flag: 'browserWaiver', resultKey: 'browserWaiverCheck', evidenceId: 'browser.waiver', ciTier: 'fast', requiresSeed: true, run: ({ season }) => runBrowserWaiverScenario({ season }) },
  { id: 'waiver-drop', flag: 'browserWaiverDrop', resultKey: 'browserWaiverDropCheck', evidenceId: 'browser.waiver_drop', ciTier: 'release', requiresSeed: true, run: ({ season }) => runBrowserWaiverDropScenario({ season }) },
  { id: 'waiver-ir-block', flag: 'browserWaiverIrBlock', resultKey: 'browserWaiverIrBlockCheck', evidenceId: 'browser.waiver_ir_block', ciTier: 'release', requiresSeed: true, run: ({ season }) => runBrowserWaiverIrBlockScenario({ season }) },
  { id: 'league-lifecycle', flag: 'browserLeagueLifecycle', resultKey: 'browserLeagueLifecycleCheck', evidenceId: 'browser.league_lifecycle', ciTier: 'fast', requiresSeed: false, run: ({ season }) => runBrowserLeagueLifecycleScenario({ season }) },
]

export const BROWSER_SCENARIOS = [
  ...STANDARD_BROWSER_SCENARIOS,
  ...TRADE_SCENARIOS.map((scenario) => ({
    ...scenario,
    id: `trade-${scenario.id}`,
    requiresSeed: false,
    run: ({ season }) => scenario.run({ season }),
  })),
]

export const browserScenarioById = (id) => {
  const scenario = BROWSER_SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown browser scenario: ${id}`)
  return scenario
}

export const fastBrowserScenarioMatrix = () => ({
  include: BROWSER_SCENARIOS
    .filter(({ ciTier }) => ciTier === 'fast')
    .map(({ id, requiresSeed }) => ({ scenario: id, seed: requiresSeed })),
})

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--ci-matrix')) {
  process.stdout.write(JSON.stringify(fastBrowserScenarioMatrix()))
}
