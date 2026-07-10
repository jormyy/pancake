import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { clickLinkByName, createBrowser, fillSignInCredentials } from './browser-agent.mjs'
import { browserDiagnosticFailures } from './browser-runtime-overrides.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const frontendUrl = process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:8082'
const artifactPath = path.join(process.cwd(), 'tests/artifacts/stack/production-hydration.json')
const session = `pancake-production-hydration-${process.pid}`
const browser = createBrowser()

export const productionBrowserFailures = browserDiagnosticFailures

const waitForPath = async (pathname) => {
  let currentUrl = frontendUrl
  for (let attempt = 0; attempt < 40; attempt += 1) {
    currentUrl = (await browser(session, ['get', 'url'])).trim()
    if (new URL(currentUrl).pathname === pathname) return currentUrl
    if (attempt < 39) await browser(session, ['wait', '250'])
  }
  throw new Error(`Production hydration did not navigate to ${pathname}; last URL was ${currentUrl}`)
}

const verifyHydration = async () => runWithScenarioResourceOwner('production-web-hydration', async () => {
  await browser(session, ['open', frontendUrl])
  await waitForPath('/sign-in')
  await fillSignInCredentials(browser, session, 'hydration-check@example.com', 'not-a-real-password')
  await clickLinkByName(browser, session, 'New to Pancake? Create an account')
  const finalUrl = await waitForPath('/sign-up')
  await browser(session, ['wait', '250'])
  const [consoleOutput, errorOutput] = await Promise.all([
    browser(session, ['console']),
    browser(session, ['errors']),
  ])
  await Promise.all([
    writeFile(path.join(path.dirname(artifactPath), 'production-hydration-console.txt'), `${consoleOutput}\n`),
    writeFile(path.join(path.dirname(artifactPath), 'production-hydration-errors.txt'), `${errorOutput}\n`),
  ])
  const failures = productionBrowserFailures({ consoleOutput, errorOutput })
  if (failures.length > 0) throw new Error(`Production hydration diagnostics failed: ${failures.join('; ')}`)
  return { status: 'PASS', finalUrl, consoleOutput, errorOutput }
})

const main = async () => {
  await mkdir(path.dirname(artifactPath), { recursive: true })
  try {
    const result = await verifyHydration()
    await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`Production hydration PASS: ${result.finalUrl}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeFile(artifactPath, `${JSON.stringify({ status: 'FAIL', error: message }, null, 2)}\n`)
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
