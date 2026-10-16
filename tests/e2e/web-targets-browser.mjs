import { chromium, webkit, devices } from 'playwright'
import { installWebTargetGeometry, webTargetGeometryReady } from './web-targets-geometry.mjs'

const webRequests = new WeakMap()

export const pressWebControl = (target, locator) => target.mobile ? locator.tap() : locator.click()

export async function waitForWebTargetReads(page) {
  const state = webRequests.get(page)
  if (!state) throw new Error('Web read settling requires an open target page')
  const started = Date.now()
  while (state.pending.size || Date.now() - Math.max(started, state.changedAt) < 500) {
    if (Date.now() - started >= 30_000) {
      throw new Error(`Web reads did not finish: ${[...state.pending].map((request) => new URL(request.url()).pathname).join(', ')}`)
    }
    await page.waitForTimeout(50)
  }
}

export async function waitForWebTargetGeometry(page, { mobile, populatedSelector = '[role="main"]', requireFirstContent = false }) {
  await page.locator(populatedSelector).waitFor({ state: 'visible' })
  await waitForWebTargetReads(page)
  const checkpoint = await page.evaluate((selector) => {
    const id = performance.now()
    Reflect.set(window, '__webTargetGeometryCheckpoint', { id, selector })
    return id
  }, populatedSelector)
  await page.waitForFunction(webTargetGeometryReady, { checkpoint, mobile, requireFirstContent }, { polling: 50, timeout: 30_000 })
  return page.evaluate(() => Reflect.get(window, '__webTargetFrames'))
}

export async function pinWebTargetLeague(target, page, { userId, memberId, leagueName }) {
  const key = `pancake:selected-league:v1:${userId}`
  const switcher = page.getByRole('button', { name: 'Switch league', exact: true })
  await switcher.waitFor()
  const selected = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.value, key)
  if (selected !== memberId || !(await switcher.textContent()).includes(leagueName)) {
    await pressWebControl(target, switcher)
    await pressWebControl(target, page.getByRole('button', { name: `Switch to ${leagueName}`, exact: true }))
  }
  await page.waitForFunction(({ key, memberId, leagueName }) =>
    JSON.parse(localStorage.getItem(key) ?? 'null')?.value === memberId &&
      document.querySelector('[aria-label="Switch league"]')?.textContent.includes(leagueName),
  { key, memberId, leagueName })
}

export const WEB_TARGETS = [
  ...[{ width: 390, height: 844 }, { width: 393, height: 852 }].flatMap((viewport) =>
    [false, true].map((standalone) => ({
      id: `iphone-webkit-${viewport.width}-${standalone ? 'standalone' : 'tab'}`,
      engine: 'webkit', mobile: true, standalone, viewport,
      insets: { top: standalone ? 0 : 59, bottom: 34 },
    }))),
  ...['chromium', 'webkit'].flatMap((engine) =>
    [{ width: 1280, height: 720 }, { width: 1440, height: 900 }].map((viewport) => ({
      id: `desktop-${engine}-${viewport.width}`, engine, mobile: false, standalone: false,
      viewport, insets: { top: 0, bottom: 0 },
    }))),
]

export async function openWebTarget(target, artifactDir, contextOptions = {}) {
  const browser = await (target.engine === 'webkit' ? webkit : chromium).launch()
  const context = await browser.newContext({
    ...(target.mobile ? devices['iPhone 13'] : {}),
    viewport: target.viewport,
    recordVideo: { dir: artifactDir, size: target.viewport },
    reducedMotion: 'reduce',
    ...contextOptions,
  })
  await context.addInitScript(({ standalone, insets }) => {
    const media = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      const result = media(query)
      if (!query.includes('display-mode: standalone')) return result
      return new Proxy(result, { get: (target, key) => {
        if (key === 'matches') return standalone
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => standalone })
    window.addEventListener('pointerdown', (event) => {
      Reflect.set(window, '__webTargetPointer', event.pointerType)
      Reflect.set(window, '__webTargetPointerTrusted', event.isTrusted)
    })
    const replaceInsets = (css) => css.replace(/env\(safe-area-inset-(top|bottom|left|right)(?:\s*,[^)]*)?\)/g,
      (_, edge) => `${insets[edge] ?? 0}px`)
    const insertRule = CSSStyleSheet.prototype.insertRule
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      return insertRule.call(this, replaceInsets(rule), index)
    }
    const patch = (node) => {
      if (!(node instanceof Element)) return
      if (node.tagName === 'STYLE' && node.textContent.includes('env(safe-area-inset-')) {
        node.textContent = replaceInsets(node.textContent)
      }
      if (node.getAttribute('style')?.includes('env(safe-area-inset-')) {
        node.setAttribute('style', replaceInsets(node.getAttribute('style')))
      }
    }
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === 'attributes') patch(change.target)
        else for (const node of change.addedNodes) {
          patch(node)
          if (node instanceof Element) node.querySelectorAll('style,[style]').forEach(patch)
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  }, { standalone: target.standalone, insets: target.insets })
  await context.addInitScript(installWebTargetGeometry, { mobile: target.mobile })
  const page = await context.newPage()
  const state = { pending: new Set(), changedAt: Date.now() }
  webRequests.set(page, state)
  page.on('request', (request) => { state.pending.add(request); state.changedAt = Date.now() })
  const finish = (request) => { state.pending.delete(request); state.changedAt = Date.now() }
  page.on('requestfinished', finish)
  page.on('requestfailed', finish)
  return { browser, context, page }
}

export const readWebLayout = (page, insets) => page.evaluate((insets) => {
  const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
  const main = document.querySelector('[role="main"]')
  const inputs = [...document.querySelectorAll('input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),textarea')]
    .filter(visible).map((node) => ({ label: node.getAttribute('aria-label') ?? node.getAttribute('placeholder'),
      font: parseFloat(getComputedStyle(node).fontSize) }))
  const duplicates = main ? [...main.querySelectorAll('*')].filter((node) => {
    const css = getComputedStyle(node)
    return node.getBoundingClientRect().height > 200 &&
      (insets.top > 0 && parseFloat(css.paddingTop) === insets.top ||
        insets.bottom > 0 && parseFloat(css.paddingBottom) === insets.bottom)
  }).map((node) => ({ tag: node.tagName, top: getComputedStyle(node).paddingTop,
    bottom: getComputedStyle(node).paddingBottom, text: node.textContent.slice(0, 70) })) : []
  return { inputs, duplicates,
    client: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      touchPoints: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, userAgent: navigator.userAgent },
    overflow: document.documentElement.scrollWidth - innerWidth,
    mainPadding: main ? { top: parseFloat(getComputedStyle(main).paddingTop), bottom: parseFloat(getComputedStyle(main).paddingBottom) } : null,
    standalone: Reflect.get(navigator, 'standalone') === true,
    mediaStandalone: matchMedia('(display-mode: standalone)').matches,
  }
}, insets)
