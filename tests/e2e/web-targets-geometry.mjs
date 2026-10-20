/** @typedef {PerformanceEntry & { value: number, hadRecentInput: boolean, sources?: { node: Node, previousRect: DOMRectReadOnly, currentRect: DOMRectReadOnly }[] }} LayoutShiftEntry */

export function installWebTargetGeometry({ mobile }) {
  const frames = []
  Reflect.set(window, '__webTargetFrames', frames)
  const box = (node) => {
    if (!node || !node.getClientRects().length) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  let observedRoot = null
  let scheduled = null
  const sources = new Set()
  const schedule = (source) => {
    sources.add(source)
    if (scheduled !== null) return
    scheduled = setTimeout(() => {
      scheduled = null
      const source = [...sources].join('+')
      sources.clear()
      sample(source)
    }, 16)
  }
  const resize = new ResizeObserver(() => schedule('resize'))
  const sample = (source) => {
    if (frames.length >= 1800) {
      clearInterval(timer)
      clearTimeout(scheduled)
      mutations.disconnect()
      resize.disconnect()
      return
    }
    if (document.documentElement && observedRoot !== document.documentElement) {
      observedRoot = document.documentElement
      resize.observe(observedRoot)
    }
    const boot = document.querySelector('#pancake-boot-shell[data-visible="1"]')
    const menu = document.querySelector('[aria-label="Open menu"]')
    const main = document.querySelector('[role="main"]')
    const shell = boot && !main
    const first = [...(main?.querySelectorAll('[role="heading"]') ?? [])].find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 2 && rect.height > 2 && rect.x >= 0
    })
    const checkpoint = Reflect.get(window, '__webTargetGeometryCheckpoint')
    frames.push({
      t: performance.now(), source, phase: shell ? 'shell' : main ? 'app' : 'loading',
      top: box(shell ? boot.querySelector('.pbs-topbar') : menu?.parentElement),
      nav: box(shell ? boot.querySelector(mobile ? '.pbs-bottomnav' : '.pbs-side') : document.querySelector('[role="navigation"][aria-label="Primary"]')),
      content: box(shell ? boot.querySelector('.pbs-content') : main?.firstElementChild), first: box(first),
      checkpoint: checkpoint?.id ?? null,
      ready: Boolean(checkpoint && box(document.querySelector(checkpoint.selector))),
      duplicate: !!boot && !!main && getComputedStyle(boot).display !== 'none',
    })
  }
  const mutations = new MutationObserver(() => schedule('mutation'))
  mutations.observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
  const timer = setInterval(() => sample('timer'), 50)
  const animation = () => {
    sample('animation-frame')
    if (frames.length < 1800) requestAnimationFrame(animation)
  }
  sample('initial')
  requestAnimationFrame(animation)
}

export function webTargetGeometryReady({ checkpoint, mobile, requireFirstContent }) {
  const samples = (Reflect.get(window, '__webTargetFrames') ?? []).filter((frame) =>
    frame.checkpoint === checkpoint && frame.ready && frame.phase === 'app' &&
    frame.nav && frame.content && (!mobile || frame.top) && (!requireFirstContent || frame.first))
  return samples.length >= 2 && samples.at(-1).t - samples[0].t >= 50
}

export const summarizeWebTargetGeometry = (frames) => ({
  sources: frames.reduce((counts, frame) => ({ ...counts, [frame.source]: (counts[frame.source] ?? 0) + 1 }), {}),
  animationFrames: frames.filter((frame) => frame.source === 'animation-frame').length,
  appAnimationFrames: frames.filter((frame) => frame.phase === 'app' && frame.source === 'animation-frame').length,
  readySamples: frames.filter((frame) => frame.ready).length,
})

export function installLayoutStability({ maxFrames = 18000 } = {}) {
  const supported = PerformanceObserver.supportedEntryTypes ?? []
  let bootCover = null
  const selector = (node) => {
    if (!(node instanceof Element)) return null
    if (node.id) return `#${CSS.escape(node.id)}`
    const parts = []
    for (let current = node; current; current = current.parentElement) {
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break }
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [current]
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`)
      if (current.getAttribute('role') === 'main') break
    }
    return parts.join(' > ')
  }
  const rect = (node) => {
    if (bootCover && !bootCover.contains(node)) return null
    const box = node.getBoundingClientRect()
    if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) return null
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null
    for (let current = node; current; current = current.parentElement) {
      const css = getComputedStyle(current)
      if (css.visibility === 'hidden' || css.display === 'none' || Number(css.opacity) === 0) return null
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }
  const state = {
    support: { cls: supported.includes('layout-shift') ? 'supported' : 'unsupported',
      geometry: 'sampled', blankFrames: 'sampled', disappearances: 'sampled', loading: 'sampled', spinners: 'sampled',
      firstPaint: supported.includes('paint') ? 'paint-api' : 'first-visible-animation-frame',
      stableLayout: 'sampled', notice: 'sampled' },
    frames: [], shifts: [], moves: [], reappearances: [], events: [], truncated: false,
  }
  let elements = new Map()
  const paintedRoutes = new Set()
  let ignoreUntil = 0
  let firstContent = null
  let lastChange = performance.now()
  let began = performance.now()
  let painted = false
  let noticeSeen = false
  let previousSignature = ''
  let active = true
  let lastRoute = location.pathname + location.search
  let previousScroll = `${scrollX}:${scrollY}`
  let maxX = 0
  let maxY = 0
  let loadingDuration = 0
  let spinnerDuration = 0
  let blankDuration = 0
  let lastFrame = null
  const round = (n) => Math.round(n * 100) / 100
  const markInput = () => { ignoreUntil = performance.now() + 500 }
  for (const name of ['pointerdown', 'keydown', 'touchstart']) addEventListener(name, markInput, { capture: true, passive: true })
  addEventListener('scroll', () => { ignoreUntil = performance.now() + 150 }, { capture: true, passive: true })
  if (state.support.cls === 'supported') {
    new PerformanceObserver((list) => {
      if (!active) return
      for (const entry of /** @type {LayoutShiftEntry[]} */ (list.getEntries())) if (entry.startTime >= began) state.shifts.push({
        t: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources ?? []).map((source) => ({ selector: selector(source.node),
          previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })),
      })
    }).observe({ type: 'layout-shift', buffered: true })
  }
  const sample = (source) => {
    if (!active) return
    if (state.frames.length >= maxFrames) { state.truncated = true; active = false; return }
    const t = performance.now()
    const route = location.pathname + location.search
    const boot = document.querySelector('#pancake-boot-shell[data-visible="1"]')
    const bootBox = boot?.getBoundingClientRect()
    const bootStyle = boot && getComputedStyle(boot)
    bootCover = bootBox && bootBox.left <= 0 && bootBox.top <= 0 && bootBox.right >= innerWidth && bootBox.bottom >= innerHeight &&
      bootStyle.display !== 'none' && bootStyle.visibility !== 'hidden' && Number(bootStyle.opacity) === 1 ? boot : null
    if (route !== lastRoute) {
      elements = new Map()
      firstContent = paintedRoutes.has(route) ? t : null
      noticeSeen = false
      lastRoute = route
    }
    const main = [...document.querySelectorAll('[role="main"],main,[role="dialog"]')].find((node) => rect(node)) ?? document.body
    if (!main) return
    const leaves = [...main.querySelectorAll('*')].filter((node) =>
      !node.closest('nav,[role="navigation"],script,style,#pancake-boot-shell') &&
      [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim()) && rect(node))
    const text = leaves.map((node) => node.textContent.trim()).join('\n')
    const loading = leaves.filter((node) => /\bLoading\b|\bChecking\b|\bCalculating\b|…/i.test(node.textContent)).map((node) => ({ selector: selector(node), text: node.textContent.slice(0, 160) }))
    const spinners = [...main.querySelectorAll('[role="progressbar"],[data-testid*="ActivityIndicator"]')].filter((node) => rect(node)).map(selector)
    const contentLeaves = leaves.filter((node) => !node.closest('[role="tablist"],[role="progressbar"]') && !loading.some((entry) => entry.selector === selector(node)))
    const hasContent = contentLeaves.length > 0 || [...main.querySelectorAll('input,textarea,img,canvas,svg')].some((node) => rect(node) && !node.closest('[role="progressbar"],nav,[role="navigation"],#pancake-boot-shell'))
    const paint = performance.getEntriesByName('first-contentful-paint')[0]
    if (paint || (!supported.includes('paint') && source === 'animation-frame' && hasContent)) painted = true
    if (painted && hasContent) {
      paintedRoutes.add(route)
      if (firstContent === null) firstContent = t
    }
    const notice = contentLeaves.some((node) => node.textContent.includes('No matchup this week yet'))
    if (notice) noticeSeen = true
    const blank = painted && firstContent !== null && !hasContent
    const scroll = `${scrollX}:${scrollY}`
    const excluded = t < ignoreUntil || scroll !== previousScroll
    previousScroll = scroll
    const candidates = [...new Set([
      ...main.querySelectorAll('h1,h2,h3,[role="heading"],[role="listitem"],[role="row"],section,article,[role="region"],button,[role="button"]'),
      ...contentLeaves,
    ])].slice(0, 200)
    const seen = new Set()
    let moved = false
    if (painted) for (const node of candidates) {
      const box = rect(node)
      if (!box) continue
      const key = `${selector(node)}|${node.textContent.trim().slice(0, 100)}`
      seen.add(key)
      const old = elements.get(key)
      if (old && old.missing && !excluded) state.reappearances.push({ t, selector: selector(node), text: node.textContent.slice(0, 100), missingSince: old.missing })
      const baseline = !old || excluded || old.missing ? box : old.baseline
      if (old && !excluded && !old.missing) {
        const x = Math.abs(box.x - baseline.x)
        const y = Math.abs(box.y - baseline.y)
        if (Math.abs(box.x - old.box.x) > 0.5 || Math.abs(box.y - old.box.y) > 0.5) {
          moved = true
          if (state.moves.length < 2000) state.moves.push({ t, selector: selector(node), text: node.textContent.slice(0, 100), previousRect: old.box, currentRect: box, dx: round(x), dy: round(y) })
        }
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      elements.set(key, { box, baseline, missing: null, node })
    }
    if (!excluded) for (const [key, value] of elements) if (!seen.has(key) && !value.missing && (!value.node.isConnected || !rect(value.node))) value.missing = t
    const signature = `${text}|${spinners.length}|${hasContent}`
    if (signature !== previousSignature || moved) lastChange = t
    previousSignature = signature
    const frame = { t: round(t), source, route, hasContent, blank, notice, noticeMissingAfterShown: noticeSeen && !notice,
      loading, spinners, tracked: seen.size, excluded, moved, visibility: document.visibilityState, bootCovered: !!bootCover }
    if (lastFrame) {
      const duration = t - lastFrame.t
      if (lastFrame.loading.length) loadingDuration += duration
      if (lastFrame.spinners.length) spinnerDuration += duration
      if (lastFrame.blank) blankDuration += duration
    }
    lastFrame = frame
    state.frames.push(frame)
  }
  const timer = setInterval(() => sample('timer'), 50)
  let scheduled = false
  const schedule = (source) => {
    if (scheduled || !active) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; sample(source) })
  }
  new MutationObserver(() => schedule('mutation')).observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
  const resize = new ResizeObserver(() => schedule('resize'))
  if (document.documentElement) resize.observe(document.documentElement)
  else addEventListener('DOMContentLoaded', () => resize.observe(document.documentElement), { once: true })
  const animation = () => { sample('animation-frame'); requestAnimationFrame(animation) }
  requestAnimationFrame(animation)
  Reflect.set(window, '__layoutStability', {
    reset: () => {
      for (const key of ['frames', 'shifts', 'moves', 'reappearances', 'events']) state[key] = []
      state.truncated = false
      elements = new Map()
      began = performance.now()
      firstContent = paintedRoutes.has(lastRoute) ? began : null
      lastChange = began
      maxX = maxY = loadingDuration = spinnerDuration = blankDuration = 0
      previousSignature = ''
      noticeSeen = false
      lastFrame = null
      active = true
      sample('reset')
    },
    mark: (name) => state.events.push({ name, t: performance.now() }),
    read: () => {
      sample('read')
      const shifts = state.shifts.filter((entry) => !entry.hadRecentInput).sort((a, b) => a.t - b.t)
      let cls = 0
      let windowStart = null
      let previous = 0
      let score = 0
      for (const entry of shifts) {
        if (windowStart !== null && entry.t - previous < 1000 && entry.t - windowStart <= 5000) score += entry.value
        else { windowStart = entry.t; score = entry.value }
        previous = entry.t
        cls = Math.max(cls, score)
      }
      return { ...state, began, ended: performance.now(), firstContentfulPaintAt: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        metrics: { cls: state.support.cls === 'supported' ? cls : 'unsupported', maxHorizontalPx: round(maxX), maxVerticalPx: round(maxY),
          blankFrames: state.frames.filter((frame) => frame.source === 'animation-frame' && frame.blank).length,
          blankDurationMs: round(blankDuration), reappearances: state.reappearances.length,
          loadingDurationMs: round(loadingDuration), spinnerDurationMs: round(spinnerDuration),
          firstContentMs: firstContent === null ? null : round(firstContent - began),
          stableLayoutMs: firstContent === null || performance.now() - lastChange < 500 ? null : round(lastChange - began),
          noticePresent: lastFrame?.notice ?? false,
          noticeMissingFrames: state.frames.filter((frame) => frame.source === 'animation-frame' && frame.noticeMissingAfterShown).length,
          animationFrames: state.frames.filter((frame) => frame.source === 'animation-frame').length,
          maxSampleGapMs: Math.max(0, ...state.frames.slice(1).map((frame, index) => frame.t - state.frames[index].t)),
        } }
    },
    stop: () => { active = false; clearInterval(timer) },
  })
}

export function layoutShiftSessionScore(entries) {
  let maximum = 0
  let start = null
  let previous = 0
  let score = 0
  for (const entry of entries.filter((entry) => !entry.hadRecentInput).sort((a, b) => a.t - b.t)) {
    if (start !== null && entry.t - previous < 1000 && entry.t - start <= 5000) score += entry.value
    else { start = entry.t; score = entry.value }
    previous = entry.t
    maximum = Math.max(maximum, score)
  }
  return maximum
}
