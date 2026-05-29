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
  'screenshot skipped; set E2E_BROWSER_SCREENSHOTS_REQUIRED=1 to require agent-browser screenshots'

const screenshotsRequired = () => process.env.E2E_BROWSER_SCREENSHOTS_REQUIRED === '1'

const screenshotTimeoutMs = () => {
  const parsed = Number(process.env.E2E_BROWSER_SCREENSHOT_TIMEOUT_MS ?? 5000)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000
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
  if (isScreenshot && !screenshotsRequired()) {
    await writeScreenshotError(args[1], SCREENSHOT_SKIP_MESSAGE)
    return ''
  }

  const timeout = isScreenshot
    ? Math.min(options.timeout ?? screenshotTimeoutMs(), screenshotTimeoutMs())
    : options.timeout ?? defaultTimeout
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd,
    timeout,
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
  if (!screenshotsRequired()) {
    await writeScreenshotError(outputPath, SCREENSHOT_SKIP_MESSAGE)
    return { ok: false, path: outputPath, skipped: true, error: SCREENSHOT_SKIP_MESSAGE }
  }

  try {
    await browser(session, ['screenshot', outputPath], { timeout: screenshotTimeoutMs() })
    return { ok: true, path: outputPath, timeout: screenshotTimeoutMs() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeScreenshotError(outputPath, message)
    throw error instanceof Error ? error : new Error(message)
  }
}
