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
import { BROWSER_SCENARIO_MANIFEST } from './browser-scenario-manifest.mjs'

const standardRunners = {
  smoke: ({ args, season }) => runBrowserSmoke({ season, fullSweep: args.browserFullSweep }),
  auth: ({ season }) => runBrowserAuthScenario({ season }),
  performance: ({ season }) => runBrowserPerfSmoke({ season }),
  auction: ({ season }) => runBrowserGameplayScenario({ season }),
  lineup: ({ season }) => runBrowserLineupScenario({ season }),
  'lineup-auto-set': ({ season }) => runBrowserLineupAutoSetScenario({ season }),
  'lineup-locked': ({ season }) => runBrowserLineupLockedScenario({ season }),
  playoffs: ({ season }) => runBrowserPlayoffChampionScenario({ season }),
  'rookie-draft': ({ season }) => runBrowserRookieDraftAutoPickScenario({ season }),
  waiver: ({ season }) => runBrowserWaiverScenario({ season }),
  'waiver-drop': ({ season }) => runBrowserWaiverDropScenario({ season }),
  'waiver-ir-block': ({ season }) => runBrowserWaiverIrBlockScenario({ season }),
  'league-lifecycle': ({ season }) => runBrowserLeagueLifecycleScenario({ season }),
}
const tradeRunners = Object.fromEntries(TRADE_SCENARIOS.map((scenario) => [
  `trade-${scenario.id}`,
  ({ season }) => scenario.run({ season }),
]))
const runners = { ...standardRunners, ...tradeRunners }

export const BROWSER_SCENARIOS = BROWSER_SCENARIO_MANIFEST.map((scenario) => {
  const run = runners[scenario.id]
  if (!run) throw new Error(`Browser scenario ${scenario.id} has no runner`)
  return { ...scenario, run }
})

export const browserScenarioById = (id) => {
  const scenario = BROWSER_SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown browser scenario: ${id}`)
  return scenario
}
