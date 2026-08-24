import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { ownScenarioResource, releaseScenarioResource } from './scenario-resource-owner.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_OPEN_TIMEOUT_MS = 60_000
const DEFAULT_LIST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 4
const DEFAULT_LIST_MAX_BUFFER = 1024 * 1024
const CDP_COMMAND_TIMEOUT_MS = 10_000
const PNG_SIGNATURE = '89504e470d0a1a0a'
const SCREENSHOT_SKIP_MESSAGE =
  'screenshot skipped because E2E_BROWSER_SKIP_SCREENSHOTS=1'

/** @typedef {{ timeout?: number, maxBuffer?: number }} BrowserCallOptions */
/** @typedef {(session: string, args: string[], options?: BrowserCallOptions) => Promise<string>} Browser */
/** @typedef {{ cwd: string, timeout: number | undefined, maxBuffer: number, session: string, args: string[] }} BrowserCommand */
/** @typedef {{ targetId: string, type: string, url: string, title?: string, attached?: boolean }} CdpTargetInfo */
/** @typedef {{ cwd: string, maxBuffer: number, session: string, outputPath: string }} PrintScreenshotCommand */

const screenshotsSkipped = () => process.env.E2E_BROWSER_SKIP_SCREENSHOTS === '1'

export const resolveScreenshotMode = ({
  configured = process.env.E2E_BROWSER_SCREENSHOT_MODE,
  platform = process.platform,
} = {}) => {
  if (configured === 'agent' || configured === 'print') return configured
  if (configured) throw new Error(`Unsupported E2E_BROWSER_SCREENSHOT_MODE: ${configured}`)
  return platform === 'darwin' ? 'print' : 'agent'
}

/** @param {CdpTargetInfo[]} targetInfos */
export const selectCdpPageTarget = (targetInfos) => {
  const pages = targetInfos.filter(({ type, url }) => type === 'page' && !url.startsWith('devtools://'))
  return pages.find(({ attached }) => attached) ?? pages.find(({ url }) => !url.startsWith('chrome://'))
}

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

/** @param {string} endpoint */
const openCdpClient = async (endpoint) => {
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), CDP_COMMAND_TIMEOUT_MS)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(undefined)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP connection failed'))
    }, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result ?? {})
  })

  return {
    /** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
    send(method, params = {}, sessionId = undefined) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, CDP_COMMAND_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('CDP connection closed'))
      }
      pending.clear()
      socket.close()
    },
  }
}

/** @param {string} endpoint */
const printPageToPdf = async (endpoint) => {
  const client = await openCdpClient(endpoint)
  try {
    const { targetInfos } = await client.send('Target.getTargets')
    const page = selectCdpPageTarget(targetInfos)
    if (!page) throw new Error('CDP found no page target for print capture')
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    await client.send('Page.enable', {}, sessionId)
    await client.send('Emulation.setEmulatedMedia', { media: 'screen' }, sessionId)
    const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId)
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
    if (!viewport?.clientWidth || !viewport?.clientHeight) {
      throw new Error('CDP returned no printable viewport dimensions')
    }
    const result = await client.send('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      paperWidth: viewport.clientWidth / 96,
      paperHeight: viewport.clientHeight / 96,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      pageRanges: '1',
    }, sessionId)
    const pdf = Buffer.from(result.data ?? '', 'base64')
    if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('CDP print capture returned invalid PDF data')
    return pdf
  } finally {
    client.close()
  }
}

/** @param {PrintScreenshotCommand} command */
const runPrintScreenshot = async ({ cwd, maxBuffer, session, outputPath }) => {
  const endpointOutput = await runAgentBrowser({
    cwd,
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer,
    session,
    args: ['get', 'cdp-url'],
  })
  const endpoint = endpointOutput.match(/ws:\/\/\S+/)?.[0]
  if (!endpoint) throw new Error('Browser did not provide a CDP endpoint for print capture')

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pancake-browser-print-'))
  try {
    const pdfPath = path.join(tempDir, 'capture.pdf')
    const pngPrefix = path.join(tempDir, 'capture')
    await writeFile(pdfPath, await printPageToPdf(endpoint))
    await execFileAsync(
      'pdftoppm',
      ['-png', '-singlefile', '-f', '1', '-r', '96', pdfPath, pngPrefix],
      { cwd, timeout: DEFAULT_COMMAND_TIMEOUT_MS, maxBuffer },
    )
    const png = await readFile(`${pngPrefix}.png`)
    if (png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
      throw new Error('Print capture conversion returned invalid PNG data')
    }
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, png)
    await unlink(`${outputPath}.error.txt`).catch(() => {})
    return `Screenshot saved to ${outputPath} through CDP print capture`
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** @param {BrowserCommand} command */
const runScreenshot = async ({ cwd, maxBuffer, session, args, timeout }) => {
  const outputPath = args[1]
  if (screenshotsSkipped()) {
    await writeScreenshotError(outputPath, SCREENSHOT_SKIP_MESSAGE)
    if (process.env.CI) throw new Error(`${SCREENSHOT_SKIP_MESSAGE}; CI requires visual evidence`)
    return ''
  }

  if (resolveScreenshotMode() === 'print') {
    try {
      return await runPrintScreenshot({ cwd, maxBuffer, session, outputPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeScreenshotError(outputPath, message)
      throw error
    }
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
  // Headed Chrome applies viewport emulation without firing a resize event,
  // so React Native's dimension hooks never re-render. Dispatch one manually.
  if (args[0] === 'set' && args[1] === 'viewport') {
    await runAgentBrowser({
      cwd,
      timeout: defaultTimeout,
      maxBuffer: effectiveMaxBuffer,
      session,
      args: ['eval', 'window.dispatchEvent(new Event("resize")); window.visualViewport && window.visualViewport.dispatchEvent(new Event("resize"))'],
    }).catch(() => {})
  }
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
