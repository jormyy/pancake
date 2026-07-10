import process from 'node:process'
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

export const TRADE_SCENARIOS = [
  { id: 'proposal', cliFlag: 'browser-trade', envFlag: 'E2E_ENABLE_BROWSER_TRADE', flag: 'browserTrade', resultKey: 'browserTradeCheck', evidenceId: 'browser.trade_proposal', ciTier: 'fast', run: runBrowserTradeScenario },
  { id: 'accept', cliFlag: 'browser-trade-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_ACCEPT', flag: 'browserTradeAccept', resultKey: 'browserTradeAcceptCheck', evidenceId: 'browser.trade_accept', ciTier: 'fast', run: runBrowserTradeAcceptScenario },
  { id: 'terminal', cliFlag: 'browser-trade-terminal', envFlag: 'E2E_ENABLE_BROWSER_TRADE_TERMINAL', flag: 'browserTradeTerminal', resultKey: 'browserTradeTerminalCheck', evidenceId: 'browser.trade_terminal', ciTier: 'fast', run: runBrowserTradeTerminalScenario },
  { id: 'future-pick', cliFlag: 'browser-trade-future-pick', envFlag: 'E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK', flag: 'browserTradeFuturePick', resultKey: 'browserTradeFuturePickCheck', evidenceId: 'browser.trade_future_pick', ciTier: 'fast', run: runBrowserTradeFuturePickScenario },
  { id: 'future-pick-accept', cliFlag: 'browser-trade-future-pick-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT', flag: 'browserTradeFuturePickAccept', resultKey: 'browserTradeFuturePickAcceptCheck', evidenceId: 'browser.trade_future_pick_accept', ciTier: 'fast', run: runBrowserTradeFuturePickAcceptScenario },
  { id: 'overflow-accept', cliFlag: 'browser-trade-overflow-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT', flag: 'browserTradeOverflowAccept', resultKey: 'browserTradeOverflowAcceptCheck', evidenceId: 'browser.trade_overflow_accept', ciTier: 'fast', run: runBrowserTradeOverflowAcceptScenario },
  { id: 'post-deadline', cliFlag: 'browser-trade-post-deadline', envFlag: 'E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE', flag: 'browserTradePostDeadline', resultKey: 'browserTradePostDeadlineCheck', evidenceId: 'browser.trade_post_deadline', ciTier: 'fast', run: runBrowserTradePostDeadlineScenario },
  { id: 'veto', cliFlag: 'browser-trade-veto', envFlag: 'E2E_ENABLE_BROWSER_TRADE_VETO', flag: 'browserTradeVeto', resultKey: 'browserTradeVetoCheck', evidenceId: 'browser.trade_veto', ciTier: 'fast', run: runBrowserTradeVetoScenario },
  { id: 'multi-team', cliFlag: 'browser-trade-multi-team', envFlag: 'E2E_ENABLE_BROWSER_TRADE_MULTI_TEAM', flag: 'browserTradeMultiTeam', resultKey: 'browserTradeMultiTeamCheck', evidenceId: 'browser.trade_multi_team', ciTier: 'fast', run: runBrowserMultiTeamTradeScenario },
]

/** @param {string[]} argv */
export const requestedTradeScenarioId = (argv) => {
  const explicit = argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]
  if (explicit) return explicit
  const legacy = TRADE_SCENARIOS.find((scenario) => scenario.id !== 'proposal' && argv.includes(`--${scenario.id}`))
  return legacy?.id ?? 'proposal'
}

export const tradeScenarioById = (scenarioId) => {
  const scenario = TRADE_SCENARIOS.find(({ id }) => id === scenarioId)
  if (!scenario) throw new Error(`Unknown trade browser scenario: ${scenarioId}`)
  return scenario
}

/**
 * @typedef {{
 *   browserTrade: boolean,
 *   browserTradeAccept: boolean,
 *   browserTradeTerminal: boolean,
 *   browserTradeFuturePick: boolean,
 *   browserTradeFuturePickAccept: boolean,
 *   browserTradeOverflowAccept: boolean,
 *   browserTradePostDeadline: boolean,
 *   browserTradeVeto: boolean,
 *   browserTradeMultiTeam: boolean,
 * }} TradeScenarioArgs
 */
/** @param {Map<string, string>} args @returns {TradeScenarioArgs} */
export const tradeScenarioArgs = (args) => /** @type {TradeScenarioArgs} */ (Object.fromEntries(
  TRADE_SCENARIOS.map((scenario) => [
    scenario.flag,
    args.get(scenario.cliFlag) === 'true' || process.env[scenario.envFlag] === '1',
  ]),
))
