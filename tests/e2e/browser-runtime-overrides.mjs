/**
 * @param {(session: string, args: string[]) => Promise<unknown>} browser
 * @param {string} session
 * @param {{ frontendUrl: string; apiBaseUrl: string; supabaseUrl: string; anonKey: string }} env
 * @param {{ openBeforeSet?: boolean; reloadAfterSet?: boolean; alerts?: boolean; confirm?: boolean }} [options]
 */
export const installRuntimeOverrides = async (browser, session, env, options = {}) => {
  const overrideUrl = new URL(env.frontendUrl)
  overrideUrl.searchParams.set('pancake_api_url', env.apiBaseUrl)
  overrideUrl.searchParams.set('pancake_supabase_url', env.supabaseUrl)
  overrideUrl.searchParams.set('pancake_supabase_public_key', env.anonKey)

  if (options.openBeforeSet !== false) {
    await browser(session, ['open', overrideUrl.toString()])
  }
  const setOverrides = () => browser(session, [
    'eval',
    `(() => {
      window.localStorage.setItem('PANCAKE_API_URL', ${JSON.stringify(env.apiBaseUrl)});
      window.localStorage.setItem('PANCAKE_SUPABASE_URL', ${JSON.stringify(env.supabaseUrl)});
      window.localStorage.setItem('PANCAKE_SUPABASE_PUBLIC_KEY', ${JSON.stringify(env.anonKey)});
      return JSON.stringify({ ok: true });
    })()`,
  ])
  try {
    await setOverrides()
  } catch (error) {
    // Under heavy parallel sessions the document can still be mid-navigation
    // (about:blank), where localStorage access throws SecurityError. Re-open
    // the app origin once and retry.
    if (!/SecurityError|Access is denied/i.test(String(error))) throw error
    await browser(session, ['open', overrideUrl.toString()])
    await setOverrides()
  }
  if (options.reloadAfterSet !== false) {
    await browser(session, ['open', env.frontendUrl])
  }
  if (options.alerts || options.confirm) {
    await browser(session, [
      'eval',
      `(() => {
      ${options.alerts ? `
      window.__pancakeAlerts = [];
      window.alert = (message) => window.__pancakeAlerts.push(String(message));
      ` : ''}
      ${options.confirm ? `
      window.confirm = (message) => {
        window.__pancakeAlerts = window.__pancakeAlerts || [];
        window.__pancakeAlerts.push(String(message));
        return true;
      };
      ` : ''}
      return JSON.stringify({ ok: true });
    })()`,
    ])
  }
}

/** @param {string} output */
export const normalizeBrowserErrors = (output) => output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !/^[\u2713\u2717\s]+$/.test(line))
  .join('\n')

const consoleErrorPattern = /(?:^\[error\]|console\.error|uncaught|unhandled|hydration failed|hydrated but|server rendered html.*did not match)/i
const allowedConsoleErrorPatterns = [
  /favicon\.ico.*(?:404|not found)/i,
]

/** @param {{ consoleOutput: string; errorOutput: string; networkOutput?: string }} output */
export const browserDiagnosticFailures = ({ consoleOutput, errorOutput, networkOutput = undefined }) => {
  /** @type {string[]} */
  const failures = []
  for (const [label, output] of Object.entries({ console: consoleOutput, errors: errorOutput })) {
    if (typeof output !== 'string' || output.includes(`${label} unavailable:`)) {
      failures.push(`${label} diagnostics unavailable`)
    }
  }
  if (networkOutput !== undefined && (typeof networkOutput !== 'string' || networkOutput.includes('network unavailable:'))) {
    failures.push('network diagnostics unavailable')
  }
  const browserErrors = normalizeBrowserErrors(errorOutput)
  if (browserErrors) failures.push(`browser errors: ${browserErrors}`)
  const consoleErrors = consoleOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => consoleErrorPattern.test(line))
    .filter((line) => !allowedConsoleErrorPatterns.some((pattern) => pattern.test(line)))
  if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`)
  return failures
}
