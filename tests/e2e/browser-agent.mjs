import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { ownScenarioResource, releaseScenarioResource } from './scenario-resource-owner.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_OPEN_TIMEOUT_MS = 60_000
const DEFAULT_LIST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 4
const DEFAULT_LIST_MAX_BUFFER = 1024 * 1024
const SCREENSHOT_SKIP_MESSAGE =
  'screenshot skipped because E2E_BROWSER_SKIP_SCREENSHOTS=1'

/** @typedef {{ timeout?: number, maxBuffer?: number }} BrowserCallOptions */
/** @typedef {(session: string, args: string[], options?: BrowserCallOptions) => Promise<string>} Browser */
/** @typedef {{ cwd: string, timeout: number | undefined, maxBuffer: number, session: string, args: string[] }} BrowserCommand */

const screenshotsSkipped = () => process.env.E2E_BROWSER_SKIP_SCREENSHOTS === '1'

/** @param {number | undefined} firstTimeout */
const screenshotTimeoutsMs = (firstTimeout) => {
  const parsed = (process.env.E2E_BROWSER_SCREENSHOT_TIMEOUTS_MS ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (parsed.length > 0) return parsed
  return firstTimeout ? [firstTimeout, firstTimeout * 2] : [60_000, 120_000]
}

/** @param {string} outputPath @param {string} message */
const writeScreenshotError = async (outputPath, message) => {
  await writeFile(`${outputPath}.error.txt`, `${message}\n`).catch(() => {})
}

/** @param {BrowserCommand} command */
const runAgentBrowser = async ({ cwd, timeout, maxBuffer, session, args }) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd,
    timeout,
    maxBuffer,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

/** @param {BrowserCommand} command */
const runScreenshot = async ({ cwd, maxBuffer, session, args, timeout }) => {
  const outputPath = args[1]
  if (screenshotsSkipped()) {
    await writeScreenshotError(outputPath, SCREENSHOT_SKIP_MESSAGE)
    if (process.env.CI) throw new Error(`${SCREENSHOT_SKIP_MESSAGE}; CI requires visual evidence`)
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

/**
 * @param {{ cwd?: string, defaultTimeout?: number, maxBuffer?: number }} [config]
 * @returns {Browser}
 */
export const createBrowser = ({
  cwd = process.cwd(),
  defaultTimeout = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) => async (session, args, options = {}) => {
  const resourceKey = `browser:${session}`
  ownScenarioResource(resourceKey, `browser session ${session}`, async () => {
    await runAgentBrowser({
      cwd,
      timeout: 10_000,
      maxBuffer,
      session,
      args: ['close'],
    })
  })
  const isScreenshot = args[0] === 'screenshot' && typeof args[1] === 'string'
  const effectiveMaxBuffer = options.maxBuffer ?? maxBuffer
  if (isScreenshot) {
    return runScreenshot({ cwd, maxBuffer: effectiveMaxBuffer, session, args, timeout: options.timeout })
  }
  const output = await runAgentBrowser({
    cwd,
    timeout: options.timeout ?? (args[0] === 'open' ? DEFAULT_OPEN_TIMEOUT_MS : defaultTimeout),
    maxBuffer: effectiveMaxBuffer,
    session,
    args,
  })
  if (args[0] === 'close') releaseScenarioResource(resourceKey)
  return output
}

/** @param {{ cwd?: string, timeout?: number, maxBuffer?: number }} [config] */
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

/** @param {string} value */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** @param {Browser} browser @param {string} session @param {string} role @param {string} name */
const refForRoleByName = async (browser, session, role, name) => {
  const pattern = new RegExp(`${escapeRegExp(role)} "${escapeRegExp(name)}" \\[ref=([^\\]]+)\\]`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const match = (await browser(session, ['snapshot'])).match(pattern)
    if (match) return match[1]
    if (attempt < 19) await browser(session, ['wait', '250'])
  }
  throw new Error(`Could not find ${role} "${name}" in browser snapshot.`)
}

/** @param {Browser} browser @param {string} session @param {string} name @param {string} value */
const fillTextboxByName = async (browser, session, name, value) => {
  await browser(session, ['fill', await refForRoleByName(browser, session, 'textbox', name), value])
}

/** @param {Browser} browser @param {string} session @param {string} name */
export const clickButtonByName = async (browser, session, name) => {
  await browser(session, ['click', await refForRoleByName(browser, session, 'button', name)])
}

/** @param {Browser} browser @param {string} session @param {string} name */
export const clickLinkByName = async (browser, session, name) => {
  await browser(session, ['click', await refForRoleByName(browser, session, 'link', name)])
}

/** @param {Browser} browser @param {string} session @param {string} email @param {string} password */
export const fillSignInCredentials = async (browser, session, email, password) => {
  await fillTextboxByName(browser, session, 'Email', email)
  await fillTextboxByName(browser, session, 'Password', password)
}

/** @param {Browser} browser @param {string} session @param {string} artifactDir @param {string} filename */
export const captureBrowserScreenshot = async (browser, session, artifactDir, filename) => {
  const outputPath = path.join(artifactDir, filename)
  if (screenshotsSkipped()) {
    await browser(session, ['screenshot', outputPath])
    return { ok: false, path: outputPath, skipped: true, error: SCREENSHOT_SKIP_MESSAGE }
  }

  await browser(session, ['screenshot', outputPath])
  return { ok: true, path: outputPath }
}
