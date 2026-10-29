import { afterEach, expect, it, vi } from 'vitest'
import { expectContent } from '../../scripts/perf-lab/actions.mjs'
import { installContentProbe } from '../../scripts/perf-lab/walk.mjs'

afterEach(() => vi.unstubAllGlobals())

it('rejects matching text outside the requested section', async () => {
  const outside = { filter() { return this }, first() { return this }, waitFor: async () => {} }
  const inside = { filter() { return this }, first() { return this }, waitFor: async () => { throw new Error('section is empty') } }
  const page = { getByText: () => outside, locator: () => ({ filter() { return this }, first() { return this }, getByText: () => inside }) }
  await expect(expectContent(page, { within: '#active-panel', text: 'Recent results' }, 'http://localhost')).rejects.toThrow('section is empty')
})

it('waits for section content before recording first paint', () => {
  const state: { __perfLabFirstContentMs?: number } = {}
  const section = { innerText: '', getClientRects: () => [{}] }
  let sample!: () => void
  vi.stubGlobal('window', state)
  vi.stubGlobal('document', { body: { innerText: 'Recent results' }, querySelector: () => section, addEventListener: () => {} })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }))
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { sample = callback } observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
  installContentProbe({ within: '#active-panel', text: 'Recent results' })
  sample()
  expect(state.__perfLabFirstContentMs).toBeUndefined()
  section.innerText = 'Recent results'
  sample()
  expect(state.__perfLabFirstContentMs).toEqual(expect.any(Number))
})
