import process from 'node:process'
import {
  runBrowserTradePostDeadlineScenario,
  runBrowserTradeScenario,
} from './browser-trade-proposal-scenarios.mjs'
import {
  runBrowserTradeAcceptScenario,
  runBrowserTradeFuturePickAcceptScenario,
  runBrowserTradeFuturePickScenario,
  runBrowserTradeOverflowAcceptScenario,
} from './browser-trade-acceptance-scenarios.mjs'
import {
  runBrowserTradeTerminalScenario,
  runBrowserTradeVetoScenario,
} from './browser-trade-terminal-scenarios.mjs'
import { runBrowserMultiTeamTradeScenario } from './browser-trade-multi-team.mjs'
import { requestedTradeScenarioId } from './trade-scenario-registry.mjs'

export {
  runBrowserTradePostDeadlineScenario,
  runBrowserTradeScenario,
  runBrowserTradeAcceptScenario,
  runBrowserTradeFuturePickAcceptScenario,
  runBrowserTradeFuturePickScenario,
  runBrowserTradeOverflowAcceptScenario,
  runBrowserTradeTerminalScenario,
  runBrowserTradeVetoScenario,
  runBrowserMultiTeamTradeScenario,
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  /** @type {Map<string, (options: { season: number }) => Promise<unknown>>} */
  const runners = new Map()
  runners.set('proposal', runBrowserTradeScenario)
  runners.set('accept', runBrowserTradeAcceptScenario)
  runners.set('terminal', runBrowserTradeTerminalScenario)
  runners.set('future-pick', runBrowserTradeFuturePickScenario)
  runners.set('future-pick-accept', runBrowserTradeFuturePickAcceptScenario)
  runners.set('overflow-accept', runBrowserTradeOverflowAcceptScenario)
  runners.set('post-deadline', runBrowserTradePostDeadlineScenario)
  runners.set('veto', runBrowserTradeVetoScenario)
  runners.set('multi-team', runBrowserMultiTeamTradeScenario)
  const scenarioId = requestedTradeScenarioId(process.argv.slice(2))
  const runner = runners.get(scenarioId)
  if (!runner) throw new Error(`Unknown trade browser scenario: ${scenarioId}`)
  runner({ season }).catch((/** @type {unknown} */ error) => {
    console.error(error)
    process.exitCode = 1
  })
}
