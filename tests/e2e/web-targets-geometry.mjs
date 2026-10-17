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
