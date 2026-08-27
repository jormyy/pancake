import process from 'node:process'

/** @typedef {'browser' | 'browserAuth' | 'browserPerf' | 'browserGameplay' | 'browserLineup' | 'browserLineupAutoSet' | 'browserLineupLocked' | 'browserPlayoff' | 'browserRookieDraft' | 'browserWaiver' | 'browserWaiverDrop' | 'browserWaiverIrBlock' | 'browserLeagueLifecycle' | 'browserTrade' | 'browserTradeAccept' | 'browserTradeTerminal' | 'browserTradeFuturePick' | 'browserTradeFuturePickAccept' | 'browserTradeOverflowAccept' | 'browserTradePostDeadline' | 'browserTradeVeto' | 'browserTradeMultiTeam' | 'browserPwaLaunch'} BrowserFlag */

/**
 * @typedef {object} BrowserScenarioMetadata
 * @property {string} id
 * @property {string} cliFlag
 * @property {string} envFlag
 * @property {BrowserFlag} flag
 * @property {string} resultKey
 * @property {string} evidenceId
 * @property {string} passNote
 * @property {string} evidence
 * @property {'fast' | 'release'} ciTier
 * @property {boolean} requiresSeed
 * @property {'release'} releaseTier
 * @property {boolean} weekly
 */

/** @type {Record<string, string>} */
const evidenceByScenarioId = {
  smoke: 'Visits the configured route sweep and retains screenshots plus console, error, and network diagnostics.',
  auth: 'Exercises browser sign-in, session persistence, sign-out, and protected-route behavior.',
  performance: 'Measures browser feedback, navigation, heartbeat lag, and mutation load against executable budgets.',
  auction: 'Places a bid through the real draft-room UI and verifies persisted nomination and bid state.',
  lineup: 'Moves a bench player through the real lineup screen, then verifies persistence and live cross-tab agreement.',
  'lineup-auto-set': 'Sets today and the remaining season through the real Auto-Set controls, then verifies every generated row.',
  'lineup-locked': 'Attempts a live-game lineup move and verifies locked-player protection in UI and storage.',
  playoffs: 'Advances a seeded playoff bracket and verifies the champion through the real browser surface.',
  'rookie-draft': 'Lets the visible rookie timer expire and verifies the browser-triggered auto-pick and roster insert.',
  waiver: 'Submits a no-drop waiver claim through the real modal and verifies the pending claim.',
  'waiver-drop': 'Submits a drop-then-add waiver claim through the real modal and verifies its drop route.',
  'waiver-ir-block': 'Verifies an ineligible IR state blocks waiver submission without persisting a claim.',
  'league-lifecycle': 'Creates and joins a league through the real forms and verifies members, slots, season, and pick bank.',
  'trade-proposal': 'Submits a player trade through the real composer and verifies routed pending items.',
  'trade-accept': 'Accepts a pending player trade through Offers and verifies atomic asset settlement.',
  'trade-terminal': 'Rejects and withdraws pending trades through real controls without moving assets.',
  'trade-future-pick': 'Proposes a future-pick trade through the real composer without moving ownership early.',
  'trade-future-pick-accept': 'Accepts a future-pick trade through Offers and verifies pick ownership settlement.',
  'trade-overflow-accept': 'Accepts over the roster cap without an eager drop, verifies lineup/add locks, then proves a corrective drop is allowed.',
  'trade-post-deadline': 'Attempts a proposal after the deadline and verifies rejection without persisted trade rows.',
  'trade-veto': 'Uses the real veto action and verifies threshold state without moving assets.',
  'trade-multi-team': 'Proposes, edits, and counters routed multi-team assets through responsive browser controls.',
  'pwa-launch': 'Relaunches the installed PWA path and verifies the static shell paints the cached identity before React mounts, hands off without duplicate chrome, precaches its boot assets, and still launches offline.',
}

/** @type {Omit<BrowserScenarioMetadata, 'evidence'>[]} */
const browserScenarioDefinitions = [
  { id: 'smoke', cliFlag: 'browser', envFlag: 'E2E_ENABLE_BROWSER', flag: 'browser', resultKey: 'browserCheck', evidenceId: 'browser.smoke', passNote: 'browser smoke passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'auth', cliFlag: 'browser-auth', envFlag: 'E2E_ENABLE_BROWSER_AUTH', flag: 'browserAuth', resultKey: 'browserAuthCheck', evidenceId: 'browser.auth', passNote: 'browser auth scenario passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'performance', cliFlag: 'browser-perf', envFlag: 'E2E_ENABLE_BROWSER_PERF', flag: 'browserPerf', resultKey: 'browserPerfCheck', evidenceId: 'browser.performance', passNote: 'browser perf smoke passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'auction', cliFlag: 'browser-gameplay', envFlag: 'E2E_ENABLE_BROWSER_GAMEPLAY', flag: 'browserGameplay', resultKey: 'browserGameplayCheck', evidenceId: 'browser.auction', passNote: 'browser auction bid gameplay passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'lineup', cliFlag: 'browser-lineup', envFlag: 'E2E_ENABLE_BROWSER_LINEUP', flag: 'browserLineup', resultKey: 'browserLineupCheck', evidenceId: 'browser.lineup', passNote: 'browser lineup gameplay passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'lineup-auto-set', cliFlag: 'browser-lineup-auto-set', envFlag: 'E2E_ENABLE_BROWSER_LINEUP_AUTO_SET', flag: 'browserLineupAutoSet', resultKey: 'browserLineupAutoSetCheck', evidenceId: 'browser.lineup_auto_set', passNote: 'browser lineup auto-set gameplay passed', ciTier: 'release', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'lineup-locked', cliFlag: 'browser-lineup-locked', envFlag: 'E2E_ENABLE_BROWSER_LINEUP_LOCKED', flag: 'browserLineupLocked', resultKey: 'browserLineupLockedCheck', evidenceId: 'browser.lineup_locked', passNote: 'browser lineup locked gameplay passed', ciTier: 'release', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'playoffs', cliFlag: 'browser-playoff', envFlag: 'E2E_ENABLE_BROWSER_PLAYOFF', flag: 'browserPlayoff', resultKey: 'browserPlayoffCheck', evidenceId: 'browser.playoffs', passNote: 'browser playoff champion passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'rookie-draft', cliFlag: 'browser-rookie-draft', envFlag: 'E2E_ENABLE_BROWSER_ROOKIE_DRAFT', flag: 'browserRookieDraft', resultKey: 'browserRookieDraftCheck', evidenceId: 'browser.rookie_draft', passNote: 'browser rookie draft auto-pick passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'waiver', cliFlag: 'browser-waiver', envFlag: 'E2E_ENABLE_BROWSER_WAIVER', flag: 'browserWaiver', resultKey: 'browserWaiverCheck', evidenceId: 'browser.waiver', passNote: 'browser waiver claim gameplay passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'waiver-drop', cliFlag: 'browser-waiver-drop', envFlag: 'E2E_ENABLE_BROWSER_WAIVER_DROP', flag: 'browserWaiverDrop', resultKey: 'browserWaiverDropCheck', evidenceId: 'browser.waiver_drop', passNote: 'browser waiver drop claim gameplay passed', ciTier: 'release', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'waiver-ir-block', cliFlag: 'browser-waiver-ir-block', envFlag: 'E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK', flag: 'browserWaiverIrBlock', resultKey: 'browserWaiverIrBlockCheck', evidenceId: 'browser.waiver_ir_block', passNote: 'browser waiver IR block gameplay passed', ciTier: 'release', requiresSeed: true, releaseTier: 'release', weekly: true },
  { id: 'league-lifecycle', cliFlag: 'browser-league-lifecycle', envFlag: 'E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE', flag: 'browserLeagueLifecycle', resultKey: 'browserLeagueLifecycleCheck', evidenceId: 'browser.league_lifecycle', passNote: 'browser league lifecycle passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: false },
  { id: 'trade-proposal', cliFlag: 'browser-trade', envFlag: 'E2E_ENABLE_BROWSER_TRADE', flag: 'browserTrade', resultKey: 'browserTradeCheck', evidenceId: 'browser.trade_proposal', passNote: 'browser trade proposal gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-accept', cliFlag: 'browser-trade-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_ACCEPT', flag: 'browserTradeAccept', resultKey: 'browserTradeAcceptCheck', evidenceId: 'browser.trade_accept', passNote: 'browser trade accept gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-terminal', cliFlag: 'browser-trade-terminal', envFlag: 'E2E_ENABLE_BROWSER_TRADE_TERMINAL', flag: 'browserTradeTerminal', resultKey: 'browserTradeTerminalCheck', evidenceId: 'browser.trade_terminal', passNote: 'browser trade reject/withdraw gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-future-pick', cliFlag: 'browser-trade-future-pick', envFlag: 'E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK', flag: 'browserTradeFuturePick', resultKey: 'browserTradeFuturePickCheck', evidenceId: 'browser.trade_future_pick', passNote: 'browser future-pick trade gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-future-pick-accept', cliFlag: 'browser-trade-future-pick-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT', flag: 'browserTradeFuturePickAccept', resultKey: 'browserTradeFuturePickAcceptCheck', evidenceId: 'browser.trade_future_pick_accept', passNote: 'browser future-pick trade accept gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-overflow-accept', cliFlag: 'browser-trade-overflow-accept', envFlag: 'E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT', flag: 'browserTradeOverflowAccept', resultKey: 'browserTradeOverflowAcceptCheck', evidenceId: 'browser.trade_overflow_accept', passNote: 'browser trade overflow accept gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-post-deadline', cliFlag: 'browser-trade-post-deadline', envFlag: 'E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE', flag: 'browserTradePostDeadline', resultKey: 'browserTradePostDeadlineCheck', evidenceId: 'browser.trade_post_deadline', passNote: 'browser post-deadline trade gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'trade-veto', cliFlag: 'browser-trade-veto', envFlag: 'E2E_ENABLE_BROWSER_TRADE_VETO', flag: 'browserTradeVeto', resultKey: 'browserTradeVetoCheck', evidenceId: 'browser.trade_veto', passNote: 'browser trade veto gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
  { id: 'pwa-launch', cliFlag: 'browser-pwa-launch', envFlag: 'E2E_ENABLE_BROWSER_PWA_LAUNCH', flag: 'browserPwaLaunch', resultKey: 'browserPwaLaunchCheck', evidenceId: 'browser.pwa_launch', passNote: 'browser PWA launch gate passed', ciTier: 'fast', requiresSeed: true, releaseTier: 'release', weekly: false },
  { id: 'trade-multi-team', cliFlag: 'browser-trade-multi-team', envFlag: 'E2E_ENABLE_BROWSER_TRADE_MULTI_TEAM', flag: 'browserTradeMultiTeam', resultKey: 'browserTradeMultiTeamCheck', evidenceId: 'browser.trade_multi_team', passNote: 'browser multi-team trade gameplay passed', ciTier: 'fast', requiresSeed: false, releaseTier: 'release', weekly: true },
]

/** @type {BrowserScenarioMetadata[]} */
export const BROWSER_SCENARIO_MANIFEST = browserScenarioDefinitions.map((scenario) => ({
  ...scenario,
  evidence: evidenceByScenarioId[scenario.id],
}))

/** @param {Map<string, string>} args @param {{ releaseEnabled?: boolean }} [options] @returns {Record<BrowserFlag, boolean>} */
export const browserScenarioArgs = (args, { releaseEnabled = false } = {}) => /** @type {Record<BrowserFlag, boolean>} */ (Object.fromEntries(
  BROWSER_SCENARIO_MANIFEST.map((scenario) => [
    scenario.flag,
    args.get(scenario.cliFlag) === 'true' || process.env[scenario.envFlag] === '1' ||
      releaseEnabled && scenario.releaseTier === 'release',
  ]),
))

/** @param {unknown} result */
const isPassingResult = (result) => result != null && typeof result === 'object' && 'status' in result && result.status === 'PASS'

/** @param {Record<string, unknown>} results */
export const browserEvidenceIds = (results) => BROWSER_SCENARIO_MANIFEST
  .flatMap((scenario) => {
    const result = results[scenario.resultKey]
    if (!isPassingResult(result)) return []
    const nestedEvidenceIds = result != null && typeof result === 'object'
      ? Reflect.get(result, 'evidenceIds')
      : []
    const resultEvidenceIds = Array.isArray(nestedEvidenceIds)
      ? nestedEvidenceIds.filter((id) => typeof id === 'string')
      : []
    return [scenario.evidenceId, ...resultEvidenceIds]
  })
  .filter((id, index, ids) => ids.indexOf(id) === index)

/** @param {Record<string, unknown>} results */
export const browserPassNotes = (results) => BROWSER_SCENARIO_MANIFEST
  .flatMap((scenario) => isPassingResult(results[scenario.resultKey]) ? [scenario.passNote] : [])

export const fastBrowserScenarioMatrix = () => ({
  include: BROWSER_SCENARIO_MANIFEST
    .map(({ id, requiresSeed }) => ({ scenario: id, seed: requiresSeed })),
})

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--ci-matrix')) {
  process.stdout.write(JSON.stringify(fastBrowserScenarioMatrix()))
}
