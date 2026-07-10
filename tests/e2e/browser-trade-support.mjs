import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

export { mkdir, writeFile, path }
export { resolvedTradeEnv, describeEndpoint } from './env.mjs'
export { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
export {
  ROOT,
  ARTIFACT_ROOT,
  assertPageText,
  browser,
  clickLastButton,
  clickTestId,
  installBrowserHooks,
  joinUrl,
  listSessions,
  openOffersTab,
  readBrowserAlerts,
  readButtonState,
  safeName,
  signInBrowser,
  tradeSessionName,
} from './trade-browser-harness.mjs'
export { setupTradeGameplayFixture } from './trade-fixture.mjs'
export { cleanupBrowserResources } from './browser-scenario-lifecycle.mjs'
export * from './browser-trade-fixtures.mjs'
export * from './browser-trade-verification.mjs'

const PROJECT_ROOT = process.cwd()
export const REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-report.md')
export const ACCEPT_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-accept-report.md')
export const TERMINAL_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-terminal-report.md')
export const FUTURE_PICK_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-future-pick-report.md')
export const FUTURE_PICK_ACCEPT_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-future-pick-accept-report.md')
export const OVERFLOW_ACCEPT_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-overflow-accept-report.md')
export const POST_DEADLINE_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-post-deadline-report.md')
export const VETO_REPORT_PATH = path.join(PROJECT_ROOT, 'tests/e2e-browser-trade-veto-report.md')
