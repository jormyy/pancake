import { afterEach, expect, it, vi } from 'vitest'
import { waitForWebAuthForm } from './web-targets-browser.mjs'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('accepts the live form on its first ready frame instead of the next locator retry', async () => {
  vi.useFakeTimers()
  const began = Date.now()
  const live = () => Date.now() - began >= 32
  const field = {
    getAttribute: () => 'Maple Manager',
    closest: () => live() ? null : {},
    getBoundingClientRect: () => ({ width: 200, height: 44 }),
  }
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => selector === 'input,textarea' ? [field] : live() ? [] : [{}],
  })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
  const inputWait = vi.fn(async () => {})
  const page = {
    locator: () => ({ waitFor: () => new Promise(resolve => setTimeout(resolve, 500)) }),
    getByPlaceholder: vi.fn(() => ({ waitFor: inputWait })),
    waitForFunction: vi.fn(async (predicate: (argument: { placeholder: string }) => boolean, argument: { placeholder: string }) => {
      while (!predicate(argument)) await new Promise(resolve => setTimeout(resolve, 16))
    }),
  }
  let ready = false
  const pending = waitForWebAuthForm(page, 'Maple Manager').then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(31)
  expect(ready).toBe(false)
  expect(page.getByPlaceholder).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ready).toBe(true)
  await pending
  expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), { placeholder: 'Maple Manager' }, { polling: 'raf', timeout: 30_000 })
  expect(page.getByPlaceholder).toHaveBeenCalledWith('Maple Manager', { exact: true })
  expect(inputWait).toHaveBeenCalledWith({ state: 'visible' })
})
