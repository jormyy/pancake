import { chromium, webkit, devices } from 'playwright'

export const pressWebControl = (target, locator) => target.mobile ? locator.tap() : locator.click()

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
  await context.addInitScript(({ standalone, insets, mobile }) => {
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
    const frames = []
    Reflect.set(window, '__webTargetFrames', frames)
    const box = (node) => {
      if (!node || !node.getClientRects().length) return null
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const sample = () => {
      const boot = document.querySelector('#pancake-boot-shell[data-visible="1"]')
      const menu = document.querySelector('[aria-label="Open menu"]')
      const main = document.querySelector('[role="main"]')
      const shell = boot && !main
      const first = [...(main?.querySelectorAll('[role="heading"]') ?? [])].find((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 2 && rect.height > 2 && rect.x >= 0
      })
      frames.push({
        t: performance.now(), phase: shell ? 'shell' : main ? 'app' : 'loading',
        top: box(shell ? boot.querySelector('.pbs-topbar') : menu?.parentElement),
        nav: box(shell ? boot.querySelector(mobile ? '.pbs-bottomnav' : '.pbs-side') : document.querySelector('[role="navigation"][aria-label="Primary"]')),
        content: box(shell ? boot.querySelector('.pbs-content') : main?.firstElementChild), first: box(first),
        duplicate: !!boot && !!main && getComputedStyle(boot).display !== 'none',
      })
      if (frames.length < 1800) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, { standalone: target.standalone, insets: target.insets, mobile: target.mobile })
  return { browser, context, page: await context.newPage() }
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
