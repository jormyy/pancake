/**
 * @typedef {'leagueLifecycle' | 'auction' | 'playoffs' | 'tiebreakers' | 'settings' | 'scoring' | 'waiverProcessing' | 'injuryFilter' | 'tradeAccept' | 'tradeVeto' | 'rookieDraft' | 'draftPush' | 'seasonReset' | 'offseasonActivity'} BackendFlag
 */

/**
 * @typedef {object} BackendScenarioMetadata
 * @property {string} id
 * @property {string} cliFlag
 * @property {string} envFlag
 * @property {BackendFlag} flag
 * @property {string} resultKey
 * @property {string} [failuresKey]
 * @property {string} evidenceId
 * @property {'release'} releaseTier
 */

/** @type {BackendScenarioMetadata[]} */
export const BACKEND_SCENARIO_MANIFEST = [
  { id: 'league-lifecycle', cliFlag: 'league-lifecycle', envFlag: 'E2E_ENABLE_LEAGUE_LIFECYCLE', flag: 'leagueLifecycle', resultKey: 'leagueLifecycleCheck', failuresKey: 'leagueLifecycleFailures', evidenceId: 'backend.league_lifecycle', releaseTier: 'release' },
  { id: 'auction', cliFlag: 'auction', envFlag: 'E2E_ENABLE_AUCTION', flag: 'auction', resultKey: 'auctionValidation', evidenceId: 'backend.auction', releaseTier: 'release' },
  { id: 'playoffs', cliFlag: 'playoffs', envFlag: 'E2E_ENABLE_PLAYOFFS', flag: 'playoffs', resultKey: 'playoffCheck', failuresKey: 'playoffFailures', evidenceId: 'backend.playoffs', releaseTier: 'release' },
  { id: 'tiebreakers', cliFlag: 'tiebreakers', envFlag: 'E2E_ENABLE_TIEBREAKERS', flag: 'tiebreakers', resultKey: 'tiebreakerCheck', failuresKey: 'tiebreakerFailures', evidenceId: 'backend.tiebreakers', releaseTier: 'release' },
  { id: 'settings', cliFlag: 'settings', envFlag: 'E2E_ENABLE_SETTINGS', flag: 'settings', resultKey: 'settingsCheck', failuresKey: 'settingsFailures', evidenceId: 'backend.settings', releaseTier: 'release' },
  { id: 'scoring', cliFlag: 'scoring', envFlag: 'E2E_ENABLE_SCORING', flag: 'scoring', resultKey: 'scoringCheck', failuresKey: 'scoringFailures', evidenceId: 'backend.scoring', releaseTier: 'release' },
  { id: 'waiver-processing', cliFlag: 'waiver-processing', envFlag: 'E2E_ENABLE_WAIVER_PROCESSING', flag: 'waiverProcessing', resultKey: 'waiverProcessingCheck', failuresKey: 'waiverProcessingFailures', evidenceId: 'backend.waiver_processing', releaseTier: 'release' },
  { id: 'injury-filter', cliFlag: 'injury-filter', envFlag: 'E2E_ENABLE_INJURY_FILTER', flag: 'injuryFilter', resultKey: 'injuryFilterCheck', failuresKey: 'injuryFilterFailures', evidenceId: 'backend.injury_filter', releaseTier: 'release' },
  { id: 'trade-accept', cliFlag: 'trade-accept', envFlag: 'E2E_ENABLE_TRADE_ACCEPT', flag: 'tradeAccept', resultKey: 'tradeAcceptCheck', failuresKey: 'tradeAcceptFailures', evidenceId: 'backend.trade_accept', releaseTier: 'release' },
  { id: 'trade-veto', cliFlag: 'trade-veto', envFlag: 'E2E_ENABLE_TRADE_VETO', flag: 'tradeVeto', resultKey: 'tradeVetoCheck', failuresKey: 'tradeVetoFailures', evidenceId: 'backend.trade_veto', releaseTier: 'release' },
  { id: 'rookie-draft', cliFlag: 'rookie-draft', envFlag: 'E2E_ENABLE_ROOKIE_DRAFT', flag: 'rookieDraft', resultKey: 'rookieDraftCheck', failuresKey: 'rookieDraftFailures', evidenceId: 'backend.rookie_draft', releaseTier: 'release' },
  { id: 'draft-push', cliFlag: 'draft-push', envFlag: 'E2E_ENABLE_DRAFT_PUSH', flag: 'draftPush', resultKey: 'draftPushCheck', failuresKey: 'draftPushFailures', evidenceId: 'push.draft', releaseTier: 'release' },
  { id: 'season-reset', cliFlag: 'season-reset', envFlag: 'E2E_ENABLE_SEASON_RESET', flag: 'seasonReset', resultKey: 'seasonResetCheck', failuresKey: 'seasonResetFailures', evidenceId: 'backend.season_reset', releaseTier: 'release' },
  { id: 'offseason-activity', cliFlag: 'offseason-activity', envFlag: 'E2E_ENABLE_OFFSEASON_ACTIVITY', flag: 'offseasonActivity', resultKey: 'offseasonActivityCheck', failuresKey: 'offseasonActivityFailures', evidenceId: 'backend.offseason_activity', releaseTier: 'release' },
]

/** @param {Map<string, string>} args @param {{ releaseEnabled?: boolean }} [options] @returns {Record<BackendFlag, boolean>} */
export const backendScenarioArgs = (args, { releaseEnabled = false } = {}) => /** @type {Record<BackendFlag, boolean>} */ (Object.fromEntries(
  BACKEND_SCENARIO_MANIFEST.map((scenario) => [
    scenario.flag,
    args.get(scenario.cliFlag) === 'true' || process.env[scenario.envFlag] === '1' ||
      releaseEnabled && scenario.releaseTier === 'release',
  ]),
))

/** @param {Record<string, unknown>} results */
export const backendEvidenceIds = (results) => BACKEND_SCENARIO_MANIFEST.flatMap((scenario) => (
  results[scenario.resultKey] != null ? [scenario.evidenceId] : []
))
