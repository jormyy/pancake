import {
  runBrowserTradeAcceptScenario,
  runBrowserTradeFuturePickAcceptScenario,
  runBrowserTradeFuturePickScenario,
  runBrowserTradeOverflowAcceptScenario,
} from './browser-trade-acceptance-scenarios.mjs'
import { runBrowserMultiTeamTradeScenario } from './browser-trade-multi-team.mjs'
import {
  runBrowserTradePostDeadlineScenario,
  runBrowserTradeScenario,
} from './browser-trade-proposal-scenarios.mjs'
import {
  runBrowserTradeTerminalScenario,
  runBrowserTradeVetoScenario,
} from './browser-trade-terminal-scenarios.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './browser-scenario-manifest.mjs'

const tradeRunners = {
  proposal: runBrowserTradeScenario,
  accept: runBrowserTradeAcceptScenario,
  terminal: runBrowserTradeTerminalScenario,
  'future-pick': runBrowserTradeFuturePickScenario,
  'future-pick-accept': runBrowserTradeFuturePickAcceptScenario,
  'overflow-accept': runBrowserTradeOverflowAcceptScenario,
  'post-deadline': runBrowserTradePostDeadlineScenario,
  veto: runBrowserTradeVetoScenario,
  'multi-team': runBrowserMultiTeamTradeScenario,
}

export const TRADE_SCENARIOS = BROWSER_SCENARIO_MANIFEST
  .filter((scenario) => scenario.id.startsWith('trade-'))
  .map((scenario) => {
    const id = scenario.id.slice('trade-'.length)
    const run = tradeRunners[id]
    if (!run) throw new Error(`Trade browser scenario ${id} has no runner`)
    return { ...scenario, id, run }
  })

/** @param {string[]} argv */
export const requestedTradeScenarioId = (argv) => {
  const explicit = argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]
  if (explicit) return explicit
  const legacy = TRADE_SCENARIOS.find((scenario) => scenario.id !== 'proposal' && argv.includes(`--${scenario.id}`))
  return legacy?.id ?? 'proposal'
}
