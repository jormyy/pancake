import { expect, it } from 'vitest'
import { expectContent } from '../../scripts/perf-lab/actions.mjs'

function pageWithValues(values: Record<string, string>) {
  const reads: string[] = []
  const locator = (selector: string) => {
    const target = { filter: () => target, first: () => target, waitFor: async () => {}, inputValue: async () => { reads.push(selector); return values[selector] } }
    return target
  }
  return { page: { locator }, reads }
}

it('checks the input named by a structured value contract, separately from its content selector', async () => {
  const { page, reads } = pageWithValues({ '#season': '2026', '#games': 'not an input' })
  await expectContent(page, { selector: '#games', value: { selector: '#season', equals: '2026' } }, 'http://localhost')
  expect(reads).toEqual(['#season'])
})

it('rejects a wrong field value even when its surrounding content exists', async () => {
  const { page } = pageWithValues({ '#note': 'old note' })
  await expect(expectContent(page, { selector: '#note', value: { selector: '#note', equals: 'new note' } }, 'http://localhost')).rejects.toThrow()
})

it('accepts an explicit empty field value without a second content selector', async () => {
  const { page } = pageWithValues({ '#name': '' })
  await expectContent(page, { value: { selector: '#name', equals: '' } }, 'http://localhost')
})

it('retains primitive values attached to a selector', async () => {
  const { page } = pageWithValues({ '#budget': '0' })
  await expectContent(page, { selector: '#budget', value: 0 }, 'http://localhost')
})

it('requires the correct field value before recording first content', async () => {
  const { vi } = await import('vitest')
  const { installContentProbe } = await import('../../scripts/perf-lab/walk.mjs')
  const field = { value: '2027', getClientRects: () => [{}] }
  let sample!: () => void
  const windowState: { __perfLabFirstContentMs?: number } = {}
  vi.stubGlobal('window', windowState)
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }))
  vi.stubGlobal('document', { querySelectorAll: () => [field], addEventListener: () => {} })
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { sample = callback } observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
  try {
    installContentProbe({ value: { selector: '#season', equals: '2026' } })
    sample()
    expect(windowState.__perfLabFirstContentMs).toBeUndefined()
    field.value = '2026'
    sample()
    expect(windowState.__perfLabFirstContentMs).toEqual(expect.any(Number))
  } finally { vi.unstubAllGlobals() }
})

it('does not record an unpainted matching input as the first visible content', async () => {
  const { vi } = await import('vitest')
  const { installContentProbe } = await import('../../scripts/perf-lab/walk.mjs')
  const field = { value: '2026', getClientRects: () => [{}] }
  let sample!: () => void
  const windowState: { __perfLabFirstContentMs?: number } = {}
  let style = { visibility: 'hidden', opacity: '1' }
  vi.stubGlobal('window', windowState)
  vi.stubGlobal('document', { querySelectorAll: () => [field], addEventListener: () => {} })
  vi.stubGlobal('getComputedStyle', () => style)
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { sample = callback } observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
  try {
    installContentProbe({ value: { selector: '#season', equals: '2026' } })
    sample()
    expect(windowState.__perfLabFirstContentMs).toBeUndefined()
    style = { visibility: 'visible', opacity: '0' }
    sample()
    expect(windowState.__perfLabFirstContentMs).toBeUndefined()
    style = { visibility: 'visible', opacity: '1' }
    sample()
    expect(windowState.__perfLabFirstContentMs).toEqual(expect.any(Number))
  } finally { vi.unstubAllGlobals() }
})
