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
  const runner = process.argv.includes('--terminal')
    ? runBrowserTradeTerminalScenario
    : process.argv.includes('--veto')
      ? runBrowserTradeVetoScenario
    : process.argv.includes('--multi-team')
      ? runBrowserMultiTeamTradeScenario
    : process.argv.includes('--overflow-accept')
      ? runBrowserTradeOverflowAcceptScenario
    : process.argv.includes('--post-deadline')
      ? runBrowserTradePostDeadlineScenario
    : process.argv.includes('--future-pick-accept')
      ? runBrowserTradeFuturePickAcceptScenario
    : process.argv.includes('--future-pick')
      ? runBrowserTradeFuturePickScenario
      : process.argv.includes('--accept')
        ? runBrowserTradeAcceptScenario
        : runBrowserTradeScenario
  runner({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
