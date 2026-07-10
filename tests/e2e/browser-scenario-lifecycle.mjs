import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'

const ROOT = process.cwd()

/** @typedef {{ timeout?: number, maxBuffer?: number }} BrowserOptions */
/** @typedef {(session: string, command: string[], options?: BrowserOptions) => Promise<string>} Browser */
/** @typedef {{ dispose: () => Promise<void> }} DisposableFixture */
/** @typedef {{ fields: Record<string, unknown>, failures: string[] }} ScenarioResult */

/** @param {unknown} error */
const errorText = (error) => error instanceof Error ? error.message : String(error)

/** @param {Browser} browser @param {string} session @param {string[]} command @param {string} label */
const browserOutput = async (browser, session, command, label) => {
  try {
    return await browser(session, command)
  } catch (error) {
    return `${label} unavailable: ${errorText(error)}`
  }
}

/** @param {string} filePath @param {string} value */
const writeText = (filePath, value) => writeFile(filePath, `${value}\n`)

/** @param {{ browser: Browser, session: string, artifactDir: string, screenshot: boolean }} input */
const captureDiagnostics = async ({ browser, session, artifactDir, screenshot }) => {
  const [consoleOutput, errorOutput, networkOutput] = await Promise.all([
    browserOutput(browser, session, ['console'], 'console'),
    browserOutput(browser, session, ['errors'], 'errors'),
    browserOutput(browser, session, ['network', 'requests'], 'network'),
  ])
  await Promise.all([
    writeText(path.join(artifactDir, 'console.txt'), consoleOutput),
    writeText(path.join(artifactDir, 'errors.txt'), errorOutput),
    writeText(path.join(artifactDir, 'network.txt'), networkOutput),
    screenshot
      ? browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 })
      : Promise.resolve(),
  ])
  return { consoleOutput, errorOutput, networkOutput }
}

/** @param {{ browser: Browser, sessions: string[], disposers?: (() => Promise<void>)[] }} input */
export const cleanupBrowserResources = async ({ browser, sessions, disposers = [] }) => {
  const results = await Promise.allSettled([
    ...sessions.map((session) => browser(session, ['close'], { timeout: 10_000 })),
    ...disposers.map((dispose) => dispose()),
  ])
  const failures = results.flatMap((result, index) => {
    if (result.status !== 'rejected') return []
    const resource = index < sessions.length
      ? `browser close ${sessions[index]}`
      : `fixture disposal ${index - sessions.length + 1}`
    return [new Error(`${resource} failed: ${errorText(result.reason)}`)]
  })
  if (failures.length > 0) throw new AggregateError(failures, 'Browser resources were not released')
}

/**
 * @param {{
 *   browser: Browser,
 *   session: string,
 *   artifactDir: string,
 *   reportPath: string,
 *   season: number,
 *   fixture: DisposableFixture,
 *   fixtureSummary: () => Record<string, unknown>,
 *   notes: string[],
 *   failureLabel: string,
 *   run: (context: { record: (values: Record<string, unknown>) => void }) => Promise<ScenarioResult>,
 *   verifyFailure: () => Promise<Record<string, unknown>>,
 * }} input
 */
export async function runBrowserScenarioLifecycle({
  browser,
  session,
  artifactDir,
  reportPath,
  season,
  fixture,
  fixtureSummary,
  notes,
  failureLabel,
  run,
  verifyFailure,
}) {
  await mkdir(artifactDir, { recursive: true })
  let report
  let primaryError = null
  /** @type {Record<string, unknown>} */
  const debug = {}
  /** @param {Record<string, unknown>} values */
  const record = (values) => Object.assign(debug, values)

  try {
    const result = await run({ record })
    const diagnostics = await captureDiagnostics({ browser, session, artifactDir, screenshot: false })
    const failures = [...result.failures]
    if (normalizeBrowserErrors(diagnostics.errorOutput)) {
      failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    }
    report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: fixtureSummary(),
      ...result.fields,
      notes,
      failures,
    }
    if (failures.length > 0) primaryError = new Error(`${failureLabel}: ${failures.join('; ')}`)
  } catch (error) {
    primaryError = error
    let diagnostics
    try {
      diagnostics = await captureDiagnostics({ browser, session, artifactDir, screenshot: true })
    } catch (diagnosticError) {
      diagnostics = { diagnosticError: errorText(diagnosticError) }
    }
    let verification = {}
    try {
      verification = await verifyFailure()
    } catch (verifyError) {
      verification = { verificationFailure: `verify unavailable: ${errorText(verifyError)}` }
    }
    report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: fixtureSummary(),
      error: errorText(error),
      debug: { ...debug, ...verification, ...diagnostics },
      notes,
    }
  }

  try {
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    await Promise.all([
      writeFile(reportPath, serialized),
      writeFile(path.join(artifactDir, 'summary.json'), serialized),
    ])
  } catch (writeError) {
    primaryError = primaryError
      ? new AggregateError([primaryError, writeError], `${failureLabel} and evidence writing failed`)
      : writeError
  }

  let cleanupError = null
  try {
    await cleanupBrowserResources({ browser, sessions: [session], disposers: [fixture.dispose] })
  } catch (error) {
    cleanupError = error
  }
  if (primaryError || cleanupError) {
    if (primaryError && !cleanupError) throw primaryError
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...(cleanupError ? [cleanupError] : [])],
      `${failureLabel}${primaryError ? ' failed' : ''}; cleanup was not clean`,
    )
  }
  return report
}
