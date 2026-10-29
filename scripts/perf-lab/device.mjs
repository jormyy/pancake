import { devices } from 'playwright'

export const phoneProfile = devices['iPhone 13']

export function emulateStandalone() {
  const matchMedia = window.matchMedia.bind(window)
  window.matchMedia = query => {
    const result = matchMedia(query)
    if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { configurable: true, value: true })
    return result
  }
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
}

export function phoneEvidence() {
  return { profile: /iPhone/.test(navigator.userAgent), touch: 'ontouchstart' in window && matchMedia('(pointer:coarse)').matches,
    standalone: navigator.standalone === true && matchMedia('(display-mode: standalone)').matches,
    installedOnDevice: false }
}
