import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolvedEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-auth-report.md')

const readState = async () => JSON.parse(await readFile(STATE_PATH, 'utf8'))

const browser = async (session, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd: ROOT,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const listSessions = async () => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')

const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const assertPageText = async (session, required, label) => {
  const result = await browser(session, [
    'eval',
    `(() => {
      const text = document.body?.innerText || '';
      const required = ${JSON.stringify(required)};
      return JSON.stringify({
        ok: required.every((value) => text.includes(value)),
        missing: required.filter((value) => !text.includes(value)),
        sample: text.slice(0, 800)
      });
    })()`,
  ])
  const parsed = parseEvalJson(result)
  if (!parsed.ok) {
    throw new Error(`${label} missing expected page text: ${parsed.missing.join(', ')}`)
  }
}

const waitForPageText = async (session, required, label) => {
  let lastError = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await assertPageText(session, required, label)
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw lastError ?? new Error(`${label}: expected page text did not appear`)
}

const waitForEmailPlaceholder = async (session, label) => {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await browser(session, ['find', 'placeholder', 'Email'])
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw new Error(`${label}: Email placeholder did not appear: ${lastError?.message ?? 'unknown error'}`)
}

const openPage = async (session, url, label, attempts = 3) => {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await browser(session, ['open', url], { timeout: 60_000 })
      return
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }
  throw new Error(`${label}: navigation failed after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`)
}

const clickExactText = async (session, text, label) => {
  const result = await browser(session, [
    'eval',
    `(() => {
      const target = [...document.querySelectorAll('*')]
        .reverse()
        .find((element) => (element.textContent || '').trim() === ${JSON.stringify(text)});
      if (!target) return JSON.stringify({ ok: false });
      target.click();
      return JSON.stringify({
        ok: true,
        tagName: target.tagName,
        role: target.getAttribute('role') || null,
        text: target.textContent
      });
    })()`,
  ])
  const parsed = parseEvalJson(result)
  if (!parsed.ok) throw new Error(`${label}: text not found: ${text}`)
}

const assertSignedInSurface = async (session, user) => {
  await openPage(session, joinUrl(resolvedEnv().frontendUrl, '/profile'), 'signed-in profile open')
  await browser(session, ['wait', '2000'])
  await waitForPageText(session, [user.email, user.displayName], 'signed-in profile')
}

const runOneAuthUser = async ({ state, env, season, userIndex, sessionList }) => {
  const user = state.users[userIndex]
  if (!user) throw new Error(`No seeded user at index ${userIndex}`)

  const session = safeName(`pancake-auth-${state.runId}-s${season}-u${userIndex + 1}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'auth', `user-${userIndex + 1}`)
  await mkdir(artifactDir, { recursive: true })
  const visited = []
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `User: ${user.email}`,
    sessionList,
  ]

  try {
    await installRuntimeOverrides(browser, session, env)
    await openPage(session, joinUrl(env.frontendUrl, '/players'), 'auth guard open')
    await browser(session, ['wait', '2000'])
    await waitForEmailPlaceholder(session, 'auth guard')
    await browser(session, ['screenshot', path.join(artifactDir, 'auth-guard.png')], { timeout: 60_000 })
    visited.push('auth-guard')

    await browser(session, ['find', 'placeholder', 'Email', 'fill', user.email])
    await browser(session, ['find', 'placeholder', 'Password', 'fill', state.password])
    await browser(session, ['find', 'text', 'Sign In', 'click'])
    await browser(session, ['wait', '4000'])
    await assertSignedInSurface(session, user)
    await browser(session, ['screenshot', path.join(artifactDir, 'signed-in-profile.png')], { timeout: 60_000 })
    visited.push('sign-in')

    await openPage(session, joinUrl(env.frontendUrl, '/players'), 'session persistence open')
    await browser(session, ['wait', '2000'])
    await assertPageText(session, ['Players'], 'session persistence')
    await browser(session, ['screenshot', path.join(artifactDir, 'session-persisted.png')], { timeout: 60_000 })
    visited.push('session-persistence')

    await openPage(session, joinUrl(env.frontendUrl, '/profile'), 'pre-sign-out profile open')
    await browser(session, ['wait', '1500'])
    await waitForPageText(session, [user.email], 'pre-sign-out profile')
    await browser(session, ['eval', 'window.confirm = () => true'])
    await browser(session, ['eval', 'document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight'])
    await browser(session, ['wait', '500'])
    await clickExactText(session, 'Sign Out', 'sign out')
    await browser(session, ['wait', '4000'])
    await openPage(session, joinUrl(env.frontendUrl, '/players'), 'signed-out guard open')
    await browser(session, ['wait', '2000'])
    await waitForEmailPlaceholder(session, 'signed-out guard')
    await browser(session, ['screenshot', path.join(artifactDir, 'signed-out-guard.png')], { timeout: 60_000 })
    visited.push('sign-out')

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)
    if (normalizeBrowserErrors(errorOutput)) {
      throw new Error(`Browser reported uncaught errors. See ${path.join(artifactDir, 'errors.txt')}`)
    }

    return {
      status: 'PASS',
      userIndex,
      user: user.email,
      session,
      visited,
      artifactDir,
      notes,
    }
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorsError) => `errors unavailable: ${errorsError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    return {
      status: 'FAIL',
      userIndex,
      user: user.email,
      session,
      visited,
      artifactDir,
      error: error instanceof Error ? error.message : String(error),
      notes,
    }
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

export async function runBrowserAuthScenario({
  season = 0,
  userCount = Number(process.env.E2E_BROWSER_AUTH_USERS ?? 10),
  concurrency = Number(process.env.E2E_BROWSER_AUTH_CONCURRENCY ?? 2),
} = {}) {
  const env = resolvedEnv()
  const state = await readState()
  if (!state.password) throw new Error('tests/e2e-state.json is missing the seeded user password')
  if (!Number.isInteger(userCount) || userCount < 1) throw new Error('E2E_BROWSER_AUTH_USERS must be a positive integer')
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('E2E_BROWSER_AUTH_CONCURRENCY must be a positive integer')

  const count = Math.min(userCount, state.users.length)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const reports = Array.from({ length: count })
  let nextIndex = 0
  const runNext = async () => {
    while (nextIndex < count) {
      const index = nextIndex
      nextIndex += 1
      reports[index] = await runOneAuthUser({
        state,
        env,
        season,
        userIndex: index,
        sessionList,
      })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, runNext),
  )

  const completedReports = reports.filter(Boolean)
  const report = {
    status: completedReports.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL',
    season,
    userCount: count,
    concurrency,
    reports: completedReports,
  }
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'PASS') {
    const failures = reports
      .filter((row) => row.status !== 'PASS')
      .map((row) => `user ${row.userIndex + 1}: ${row.error}`)
      .join('; ')
    throw new Error(`Browser auth scenario failed: ${failures}`)
  }
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const usersArg = process.argv.find((arg) => arg.startsWith('--users='))
  runBrowserAuthScenario({
    season: seasonArg ? Number(seasonArg.split('=')[1]) : 0,
    userCount: usersArg ? Number(usersArg.split('=')[1]) : undefined,
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
