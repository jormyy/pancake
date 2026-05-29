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

const screenshotTimeoutsMs = () => {
  const parsed = (process.env.E2E_BROWSER_SCREENSHOT_TIMEOUTS_MS ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  return parsed.length > 0 ? parsed : [60_000, 120_000]
}

const writeScreenshotError = async (outputPath, message) => {
  await writeFile(`${outputPath}.error.txt`, `${message}\n`).catch(() => {})
}

export const createBrowser = ({
  cwd = process.cwd(),
  defaultTimeout = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) => async (session, args, options = {}) => {
  const isScreenshot = args[0] === 'screenshot' && typeof args[1] === 'string'
  if (isScreenshot && screenshotsSkipped()) {
    await writeScreenshotError(args[1], SCREENSHOT_SKIP_MESSAGE)
    return ''
  }

  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd,
    timeout: options.timeout ?? defaultTimeout,
    maxBuffer: options.maxBuffer ?? maxBuffer,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
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

export const captureBrowserScreenshot = async (browser, session, artifactDir, filename) => {
  const outputPath = path.join(artifactDir, filename)
  if (screenshotsSkipped()) {
    await writeScreenshotError(outputPath, SCREENSHOT_SKIP_MESSAGE)
    return { ok: false, path: outputPath, skipped: true, error: SCREENSHOT_SKIP_MESSAGE }
  }

  let lastError = null
  for (const timeout of screenshotTimeoutsMs()) {
    try {
      await browser(session, ['screenshot', outputPath], { timeout })
      return { ok: true, path: outputPath, timeout }
    } catch (error) {
      lastError = error
      await browser(session, ['wait', '1000']).catch(() => {})
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  await writeScreenshotError(outputPath, message)
  throw lastError instanceof Error ? lastError : new Error(message)
}
