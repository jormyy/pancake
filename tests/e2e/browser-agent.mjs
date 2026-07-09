import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_LIST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 4
const DEFAULT_LIST_MAX_BUFFER = 1024 * 1024
const SCREENSHOT_SKIP_MESSAGE =
  'screenshot skipped because E2E_BROWSER_SKIP_SCREENSHOTS=1'

const screenshotsSkipped = () => process.env.E2E_BROWSER_SKIP_SCREENSHOTS === '1'

const screenshotTimeoutsMs = (firstTimeout) => {
  const parsed = (process.env.E2E_BROWSER_SCREENSHOT_TIMEOUTS_MS ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (parsed.length > 0) return parsed
  return firstTimeout ? [firstTimeout, firstTimeout * 2] : [60_000, 120_000]
}

const writeScreenshotError = async (outputPath, message) => {
  await writeFile(`${outputPath}.error.txt`, `${message}\n`).catch(() => {})
}

const runAgentBrowser = async ({ cwd, timeout, maxBuffer, session, args }) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd,
    timeout,
    maxBuffer,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const runScreenshot = async ({ cwd, maxBuffer, session, args, timeout }) => {
  const outputPath = args[1]
  if (screenshotsSkipped()) {
    await writeScreenshotError(outputPath, SCREENSHOT_SKIP_MESSAGE)
    return ''
  }

  const timeouts = screenshotTimeoutsMs(timeout)
  let lastError = null
  for (const screenshotTimeout of timeouts) {
    try {
      return await runAgentBrowser({ cwd, timeout: screenshotTimeout, maxBuffer, session, args })
    } catch (error) {
      lastError = error
      await runAgentBrowser({ cwd, timeout: DEFAULT_COMMAND_TIMEOUT_MS, maxBuffer, session, args: ['wait', '1000'] }).catch(() => {})
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  await writeScreenshotError(outputPath, message)
  throw lastError instanceof Error ? lastError : new Error(message)
}

export const createBrowser = ({
  cwd = process.cwd(),
  defaultTimeout = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) => async (session, args, options = {}) => {
  const isScreenshot = args[0] === 'screenshot' && typeof args[1] === 'string'
  const effectiveMaxBuffer = options.maxBuffer ?? maxBuffer
  if (isScreenshot) {
    return runScreenshot({ cwd, maxBuffer: effectiveMaxBuffer, session, args, timeout: options.timeout })
  }
  return runAgentBrowser({
    cwd,
    timeout: options.timeout ?? defaultTimeout,
    maxBuffer: effectiveMaxBuffer,
    session,
    args,
  })
}

export const listBrowserSessions = async ({
  cwd = process.cwd(),
  timeout = DEFAULT_LIST_TIMEOUT_MS,
  maxBuffer = DEFAULT_LIST_MAX_BUFFER,
} = {}) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd,
    timeout,
    maxBuffer,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const refForRoleByName = async (browser, session, role, name) => {
  const snapshot = await browser(session, ['snapshot'])
  const pattern = new RegExp(`${escapeRegExp(role)} "${escapeRegExp(name)}" \\[ref=([^\\]]+)\\]`)
  const match = snapshot.match(pattern)
  if (!match) throw new Error(`Could not find ${role} "${name}" in browser snapshot.`)
  return match[1]
}

const fillTextboxByName = async (browser, session, name, value) => {
  await browser(session, ['fill', await refForRoleByName(browser, session, 'textbox', name), value])
}

export const clickButtonByName = async (browser, session, name) => {
  await browser(session, ['click', await refForRoleByName(browser, session, 'button', name)])
}

export const fillSignInCredentials = async (browser, session, email, password) => {
  await fillTextboxByName(browser, session, 'Email', email)
  await fillTextboxByName(browser, session, 'Password', password)
}

export const captureBrowserScreenshot = async (browser, session, artifactDir, filename) => {
  const outputPath = path.join(artifactDir, filename)
  if (screenshotsSkipped()) {
    await browser(session, ['screenshot', outputPath])
    return { ok: false, path: outputPath, skipped: true, error: SCREENSHOT_SKIP_MESSAGE }
  }

  try {
    await browser(session, ['screenshot', outputPath])
    return { ok: true, path: outputPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, path: outputPath, error: message }
  }
}
