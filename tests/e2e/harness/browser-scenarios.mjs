import { runBrowserSmoke } from '../browser-smoke.mjs'
import { runBrowserAuthScenario } from '../browser-auth.mjs'
import { runBrowserPerfSmoke } from '../browser-perf-smoke.mjs'
import { runBrowserGameplayScenario } from '../browser-gameplay.mjs'
import { runBrowserLeagueLifecycleScenario } from '../browser-league-lifecycle.mjs'
import {
  runBrowserLineupAutoSetScenario,
  runBrowserLineupLockedScenario,
  runBrowserLineupScenario,
} from '../browser-lineup-gameplay.mjs'
import { runBrowserPlayoffChampionScenario } from '../browser-playoff-gameplay.mjs'
import { runBrowserRookieDraftAutoPickScenario } from '../browser-rookie-draft-gameplay.mjs'
import {
  runBrowserWaiverDropScenario,
  runBrowserWaiverIrBlockScenario,
  runBrowserWaiverScenario,
} from '../browser-waiver-gameplay.mjs'
import {
  runBrowserTradeScenario,
  runBrowserTradeAcceptScenario,
  runBrowserTradeTerminalScenario,
  runBrowserTradeFuturePickScenario,
  runBrowserTradeFuturePickAcceptScenario,
  runBrowserTradeOverflowAcceptScenario,
  runBrowserTradePostDeadlineScenario,
  runBrowserTradeVetoScenario,
  runBrowserMultiTeamTradeScenario,
} from '../browser-trade-gameplay.mjs'

const ONE_TIME_BROWSER_SCENARIOS = [
  { flag: 'browser', resultKey: 'browserCheck', run: ({ args, season }) => runBrowserSmoke({ season, fullSweep: args.browserFullSweep }) },
  { flag: 'browserAuth', resultKey: 'browserAuthCheck', run: ({ season }) => runBrowserAuthScenario({ season }) },
  { flag: 'browserPerf', resultKey: 'browserPerfCheck', run: ({ season }) => runBrowserPerfSmoke({ season }) },
  { flag: 'browserGameplay', resultKey: 'browserGameplayCheck', run: ({ season }) => runBrowserGameplayScenario({ season }) },
  { flag: 'browserLineup', resultKey: 'browserLineupCheck', run: ({ season }) => runBrowserLineupScenario({ season }) },
  { flag: 'browserLineupAutoSet', resultKey: 'browserLineupAutoSetCheck', run: ({ season }) => runBrowserLineupAutoSetScenario({ season }) },
  { flag: 'browserLineupLocked', resultKey: 'browserLineupLockedCheck', run: ({ season }) => runBrowserLineupLockedScenario({ season }) },
  { flag: 'browserPlayoff', resultKey: 'browserPlayoffCheck', run: ({ season }) => runBrowserPlayoffChampionScenario({ season }) },
  { flag: 'browserRookieDraft', resultKey: 'browserRookieDraftCheck', run: ({ season }) => runBrowserRookieDraftAutoPickScenario({ season }) },
  { flag: 'browserWaiver', resultKey: 'browserWaiverCheck', run: ({ season }) => runBrowserWaiverScenario({ season }) },
  { flag: 'browserWaiverDrop', resultKey: 'browserWaiverDropCheck', run: ({ season }) => runBrowserWaiverDropScenario({ season }) },
  { flag: 'browserWaiverIrBlock', resultKey: 'browserWaiverIrBlockCheck', run: ({ season }) => runBrowserWaiverIrBlockScenario({ season }) },
  { flag: 'browserTrade', resultKey: 'browserTradeCheck', run: ({ season }) => runBrowserTradeScenario({ season }) },
  { flag: 'browserTradeAccept', resultKey: 'browserTradeAcceptCheck', run: ({ season }) => runBrowserTradeAcceptScenario({ season }) },
  { flag: 'browserTradeTerminal', resultKey: 'browserTradeTerminalCheck', run: ({ season }) => runBrowserTradeTerminalScenario({ season }) },
  { flag: 'browserTradeFuturePick', resultKey: 'browserTradeFuturePickCheck', run: ({ season }) => runBrowserTradeFuturePickScenario({ season }) },
  { flag: 'browserTradeFuturePickAccept', resultKey: 'browserTradeFuturePickAcceptCheck', run: ({ season }) => runBrowserTradeFuturePickAcceptScenario({ season }) },
  { flag: 'browserTradeOverflowAccept', resultKey: 'browserTradeOverflowAcceptCheck', run: ({ season }) => runBrowserTradeOverflowAcceptScenario({ season }) },
  { flag: 'browserTradePostDeadline', resultKey: 'browserTradePostDeadlineCheck', run: ({ season }) => runBrowserTradePostDeadlineScenario({ season }) },
  { flag: 'browserTradeVeto', resultKey: 'browserTradeVetoCheck', run: ({ season }) => runBrowserTradeVetoScenario({ season }) },
  { flag: 'browserTradeMultiTeam', resultKey: 'browserTradeMultiTeamCheck', run: ({ season }) => runBrowserMultiTeamTradeScenario({ season }) },
  { flag: 'browserLeagueLifecycle', resultKey: 'browserLeagueLifecycleCheck', run: ({ season }) => runBrowserLeagueLifecycleScenario({ season }) },
]

export async function runBrowserScenarios({ args, season, shouldRun }) {
  const results = Object.fromEntries(
    ONE_TIME_BROWSER_SCENARIOS.map((scenario) => [scenario.resultKey, null]),
  )

  for (const scenario of ONE_TIME_BROWSER_SCENARIOS) {
    if (args[scenario.flag] && shouldRun(args, season)) {
      results[scenario.resultKey] = await scenario.run({ args, season })
    }
  }

  return results
}
