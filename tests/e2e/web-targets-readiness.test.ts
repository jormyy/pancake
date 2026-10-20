import { afterEach, expect, it, vi } from 'vitest'
import { waitForWebAuthForm, waitForWebTargetReady } from './web-targets-browser.mjs'

type ReadyArgument = { placeholder: string | null }
type ReadyPredicate = (argument: ReadyArgument) => boolean

const element = (textContent = '') => ({
  textContent,
  visibility: 'visible',
  width: 200,
  height: 44,
  getBoundingClientRect() { return { width: this.width, height: this.height } },
})

afterEach(() => { vi.unstubAllGlobals() })

it('requires visible navigation, visible main content, and meaningful text in the same frame', async () => {
  const nav = element()
  const main = element('Roster')
  const nodes = new Map<string, ReturnType<typeof element>[]>()
  vi.stubGlobal('document', { querySelectorAll: (selector: string) => nodes.get(selector) ?? [] })
  vi.stubGlobal('getComputedStyle', (node: ReturnType<typeof element>) => ({ visibility: node.visibility }))
  const waitForFunction = vi.fn(async (_predicate: ReadyPredicate, _argument: ReadyArgument, _options: object) => {})
  await waitForWebTargetReady({ waitForFunction })
  const [predicate, argument, options] = waitForFunction.mock.calls[0]
  expect(options).toEqual({ polling: 'raf', timeout: 45_000 })
  expect(predicate(argument)).toBe(false)
  nodes.set('[role="navigation"][aria-label="Primary"]', [nav])
  expect(predicate(argument)).toBe(false)
  nodes.set('[role="main"]', [main])
  expect(predicate(argument)).toBe(true)
  main.visibility = 'hidden'
  expect(predicate(argument)).toBe(false)
  main.visibility = 'collapse'
  expect(predicate(argument)).toBe(false)
  main.visibility = 'visible'
  nav.width = 0
  expect(predicate(argument)).toBe(false)
  nav.width = 200
  main.height = 0
  expect(predicate(argument)).toBe(false)
  main.height = 44
  main.textContent = '     '
  expect(predicate(argument)).toBe(false)
  main.textContent = '12345'
  expect(predicate(argument)).toBe(false)
  main.textContent = 'Roster'
  expect(predicate(argument)).toBe(true)
  nodes.set('[role="navigation"][aria-label="Primary"]', [nav, element()])
  expect(() => predicate(argument)).toThrow('More than one primary navigation')
  nodes.set('[role="navigation"][aria-label="Primary"]', [nav])
  nodes.set('[role="main"]', [main, element('Duplicate')])
  expect(() => predicate(argument)).toThrow('More than one main region')
})

it('keeps the document-copy, exact placeholder, visibility, and inert guards for auth', async () => {
  let documentCopies = 1
  let inert = true
  let placeholder = 'Maple Manager'
  const field = {
    ...element(),
    getAttribute: () => placeholder,
    closest: () => inert ? {} : null,
  }
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => selector === 'input,textarea' ? [field] : Array.from({ length: documentCopies }, () => ({})),
  })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: field.visibility }))
  const waitForFunction = vi.fn(async (_predicate: ReadyPredicate, _argument: ReadyArgument, _options: object) => {})
  await waitForWebAuthForm({ waitForFunction, getByPlaceholder: () => ({ waitFor: async () => {} }) }, 'Maple Manager')
  const [predicate, argument] = waitForFunction.mock.calls[0]
  expect(predicate(argument)).toBe(false)
  documentCopies = 2
  expect(() => predicate(argument)).toThrow('More than one auth document')
  documentCopies = 0
  expect(predicate(argument)).toBe(false)
  inert = false
  expect(predicate(argument)).toBe(true)
  placeholder = 'Maple Manager extra'
  expect(predicate(argument)).toBe(false)
  placeholder = 'Maple Manager'
  field.visibility = 'hidden'
  expect(predicate(argument)).toBe(false)
  field.visibility = 'visible'
  field.height = 0
  expect(predicate(argument)).toBe(false)
})
