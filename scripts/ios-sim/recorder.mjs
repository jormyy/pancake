function installRecorder() {
  if (window['__iosRecorder']) return
  const visible = element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent)
      if (Number(parentStyle.opacity) === 0 || parentStyle.visibility === 'hidden' || parentStyle.display === 'none') return false
      if (/(hidden|clip|scroll|auto)/.test(`${parentStyle.overflowX} ${parentStyle.overflowY}`)) {
        const clip = parent.getBoundingClientRect()
        if (rect.right <= clip.left || rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom) return false
      }
    }
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
  }
  const nodes = new WeakMap()
  let sequence = 0, frame, active, previous = new Map(), dirty = true, offline = false
  const requests = []
  const originalFetch = window.fetch.bind(window)
  const requestUrl = input => {
    try { const url = new URL(typeof input === 'string' ? input : input.url, location.href); return `${url.origin}${url.pathname}` } catch { return String(input) }
  }
  window.fetch = function (input, init) {
    const url = requestUrl(input)
    if (!url.includes('/__ios/')) requests.push({ time: Date.now(), url, kind: 'fetch' })
    if (offline && !url.includes('/__ios/')) return Promise.reject(new TypeError('Harness offline mode'))
    return originalFetch(input, init)
  }
  const open = XMLHttpRequest.prototype.open
  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this['__iosUrl'] = requestUrl(url); return open.call(this, method, url, ...rest) }
  XMLHttpRequest.prototype.send = function (...args) { if (!this['__iosUrl'].includes('/__ios/')) requests.push({ time: Date.now(), url: this['__iosUrl'], kind: 'xhr' }); return send.apply(this, args) }
  let resourceObserver
  if (typeof PerformanceObserver !== 'undefined') {
    resourceObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (['fetch', 'xmlhttprequest'].includes(entry['initiatorType']) || entry.name.includes('/__ios/')) continue
        requests.push({ time: performance.timeOrigin + entry.startTime, url: requestUrl(entry.name), kind: entry['initiatorType'] })
      }
    })
    resourceObserver.observe({ type: 'resource', buffered: true })
  }
  const snapshot = () => {
    const result = new Map()
    for (const element of document.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'PATH'].includes(element.tagName) || !visible(element)) continue
      if (!nodes.has(element)) nodes.set(element, ++sequence)
      const box = element.getBoundingClientRect()
      const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(box[key] * 10) / 10]))
      const directText = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim()
      const text = ['INPUT', 'TEXTAREA'].includes(element.tagName) ? (element.getAttribute('type') === 'password' ? '' : element['value']) : element.tagName === 'SELECT' ? [...element['selectedOptions']].map(option => option.textContent).join(' ') : directText
      result.set(nodes.get(element), { nodeId: nodes.get(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox' })[element.tagName] || null, label: element.getAttribute('aria-label') || element.getAttribute('alt') || null, text, rect })
    }
    return result
  }
  const meaningful = spec => {
    if (spec.route) { const target = new URL(spec.route, location.href); if (location.pathname !== target.pathname || (spec.route.includes('?') && location.search !== target.search)) return false }
    if (spec.value && document.querySelector(spec.value.selector)?.value !== spec.value.equals) return false
    if (spec.dialog) return [...document.querySelectorAll('[role=dialog]')].some(element => visible(element) && (element.getAttribute('aria-label') === spec.dialog || (element.getAttribute('aria-labelledby') || '').split(' ').some(id => document.getElementById(id)?.textContent === spec.dialog)))
    if (spec.selector) return [...document.querySelectorAll(spec.selector)].some(visible)
    if (spec.text) return [...document.querySelectorAll('body *')].some(element => visible(element) && (element.getAttribute('aria-label') === spec.text || [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.includes(spec.text))))
    return false
  }
  const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 0.5)
  const emit = (kind, before, after, now) => {
    active.events.push({ kind, timeMs: now - active.startedAt, element: after ?? before, before: before ?? null, after: after ?? null })
    active.lastChange = now
  }
  const sample = () => {
    if (!active || document.hidden) { frame = null; return }
    const began = performance.now(), now = Date.now()
    const current = snapshot()
    active.samples++
    if (!active.triggered) { if (now - active.startedAt > active.maximumMs) { finish(false); return }; frame = requestAnimationFrame(sample); return }
    if (active.firstContentMs === null && meaningful(active.expected)) {
      active.firstContentMs = now - active.startedAt
      active.firstPaintAt = now
      active.lastChange = now
      previous = current
    } else if (active.firstContentMs !== null) {
      for (const [id, before] of previous) {
        const after = current.get(id)
        if (!after) emit('disappear', before, null, now)
        else {
          if (!sameRect(before.rect, after.rect)) emit('rect', before, after, now)
          if (before.text !== after.text || before.label !== after.label || before.role !== after.role) emit('content', before, after, now)
        }
      }
      for (const [id, after] of current) if (!previous.has(id)) emit('appear', null, after, now)
      previous = current
    }
    active.samplingMs += performance.now() - began
    dirty = false
    const lastRequest = requests.filter(request => request.time >= active.startedAt).at(-1)?.time ?? active.startedAt
    const settled = active.firstContentMs !== null && now - Math.max(active.lastChange, lastRequest, active.firstPaintAt) >= active.quietMs
    if ((settled && now - active.startedAt >= active.minimumMs) || now - active.startedAt > active.maximumMs) { finish(settled); return }
    frame = requestAnimationFrame(sample)
  }
  const finish = settled => {
    if (!active) return null
    cancelAnimationFrame(frame)
    const result = { ...active, settled, durationMs: Date.now() - active.startedAt, requests: requests.filter(request => request.time >= active.startedAt), viewport: { width: innerWidth, height: innerHeight }, standalone: navigator['standalone'] === true || matchMedia('(display-mode: standalone)').matches, route: `${location.pathname}${location.search}`, method: 'mutation-observer-and-animation-frame', dirtyAtFinish: dirty }
    result.requestCount = result.requests.length
    active = null
    originalFetch('/__ios/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }).catch(() => {})
    return result
  }
  const begin = spec => {
    if (active?.id === spec.id) return
    if (active) finish(false)
    active = { ...spec, triggered: spec.immediate === true, startedAt: spec.startedAt ?? Date.now(), firstContentMs: null, firstPaintAt: null, lastChange: Date.now(), events: [], samples: 0, samplingMs: 0, quietMs: spec.quietMs ?? 1200, minimumMs: spec.minimumMs ?? 3500, maximumMs: spec.maximumMs ?? 12000 }
    const prior = JSON.parse(sessionStorage.getItem('__ios_step') || 'null')
    if (prior?.id === spec.id) { active.startedAt = prior.startedAt; active.triggered = true }
    previous = new Map()
    dirty = true
    frame = requestAnimationFrame(sample)
  }
  const mutations = new MutationObserver(() => { dirty = true })
  mutations.observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true })
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(frame); else if (active) frame = requestAnimationFrame(sample) })
  for (const event of ['pointerdown', 'mousedown', 'click', 'touchstart']) document.addEventListener(event, () => { if (active && !active.triggered) { active.startedAt = Date.now(); active.triggered = true; sessionStorage.setItem('__ios_step', JSON.stringify({ id: active.id, startedAt: active.startedAt })) } }, true)
  window['__iosRecorder'] = { begin, finish, snapshot: () => [...snapshot().values()], disconnect: () => { finish(false); mutations.disconnect(); resourceObserver?.disconnect(); control.close() } }
  const standalone = navigator['standalone'] === true || matchMedia('(display-mode: standalone)').matches
  const control = new EventSource(`/__ios/control?standalone=${standalone ? 1 : 0}`)
  control.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.type === 'begin') begin(message.spec)
    if (message.type === 'finish') finish(false)
    if (message.type === 'prepare') location.assign(message.url)
    if (message.type === 'reset-auth') { localStorage.clear(); sessionStorage.clear(); location.replace(message.url) }
    if (message.type === 'blur') document.activeElement?.['blur']?.()
    if (message.type === 'offline') { offline = message.value; Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !offline }); dispatchEvent(new Event(offline ? 'offline' : 'online')) }
  }
}

export const recorderSource = `(${installRecorder.toString()})();`
