export const TRADE_SCENARIOS = [
  { id: 'proposal', flag: 'browserTrade', resultKey: 'browserTradeCheck', evidenceId: 'browser.trade_proposal' },
  { id: 'accept', flag: 'browserTradeAccept', resultKey: 'browserTradeAcceptCheck', evidenceId: 'browser.trade_accept' },
  { id: 'terminal', flag: 'browserTradeTerminal', resultKey: 'browserTradeTerminalCheck', evidenceId: 'browser.trade_terminal' },
  { id: 'future-pick', flag: 'browserTradeFuturePick', resultKey: 'browserTradeFuturePickCheck', evidenceId: 'browser.trade_future_pick' },
  { id: 'future-pick-accept', flag: 'browserTradeFuturePickAccept', resultKey: 'browserTradeFuturePickAcceptCheck', evidenceId: 'browser.trade_future_pick_accept' },
  { id: 'overflow-accept', flag: 'browserTradeOverflowAccept', resultKey: 'browserTradeOverflowAcceptCheck', evidenceId: 'browser.trade_overflow_accept' },
  { id: 'post-deadline', flag: 'browserTradePostDeadline', resultKey: 'browserTradePostDeadlineCheck', evidenceId: 'browser.trade_post_deadline' },
  { id: 'veto', flag: 'browserTradeVeto', resultKey: 'browserTradeVetoCheck', evidenceId: 'browser.trade_veto' },
  { id: 'multi-team', flag: 'browserTradeMultiTeam', resultKey: 'browserTradeMultiTeamCheck', evidenceId: 'browser.trade_multi_team' },
]

/** @param {string[]} argv */
export const requestedTradeScenarioId = (argv) => {
  const explicit = argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]
  if (explicit) return explicit
  const legacy = TRADE_SCENARIOS.find((scenario) => scenario.id !== 'proposal' && argv.includes(`--${scenario.id}`))
  return legacy?.id ?? 'proposal'
}
