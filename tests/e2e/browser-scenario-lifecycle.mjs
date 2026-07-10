import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'

const ROOT = process.cwd()

const errorText = (error) => error instanceof Error ? error.message : String(error)

const browserOutput = async (browser, session, command, label) => {
  try {
    return await browser(session, command)
  } catch (error) {
    return `${label} unavailable: ${errorText(error)}`
  }
}

const writeText = (filePath, value) => writeFile(filePath, `${value}\n`)

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

const cleanupResources = async (browser, session, dispose) => {
  const results = await Promise.allSettled([
    browser(session, ['close'], { timeout: 10_000 }),
    dispose(),
  ])
  return results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${index === 0 ? 'browser close' : 'fixture disposal'} failed: ${errorText(result.reason)}`)]
    : [])
}

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
  const debug = {}
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

  const cleanupErrors = await cleanupResources(browser, session, fixture.dispose)
  if (primaryError || cleanupErrors.length > 0) {
    if (primaryError && cleanupErrors.length === 0) throw primaryError
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      `${failureLabel}${primaryError ? ' failed' : ''}; cleanup was not clean`,
    )
  }
  return report
}
