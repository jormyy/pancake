import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmTradeAcceptance } from './e2e/confirm-trade-acceptance.mjs'

afterEach(() => vi.useRealTimers())

describe('trade acceptance confirmation', () => {
  it('presses the in-page confirmation after it appears', async () => {
    vi.useFakeTimers()
    const browserCall = vi.fn().mockResolvedValueOnce('false').mockResolvedValueOnce('true').mockResolvedValue('clicked')
    const result = confirmTradeAcceptance({ session: 'owned', browserCall })
    await vi.runAllTimersAsync()
    expect(await result).toBe(true)
    expect(browserCall).toHaveBeenLastCalledWith('owned', ['click', '[role="dialog"] [aria-label="Accept"]'])
    expect(browserCall.mock.calls.filter(([, args]) => args[0] === 'click')).toHaveLength(1)
  })

  it('continues on deployed frontends without a dialog', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const browserCall = vi.fn().mockResolvedValue('false')
    const result = confirmTradeAcceptance({ session: 'owned', browserCall })
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(browserCall.mock.calls.every(([, args]) => args[0] === 'eval')).toBe(true)
    expect(Date.now() - startedAt).toBe(1500)
  })

  it('propagates browser failures', async () => {
    const browserCall = vi.fn().mockRejectedValue(new Error('browser disconnected'))
    await expect(confirmTradeAcceptance({ session: 'owned', browserCall })).rejects.toThrow('browser disconnected')
  })

  it('uses the same confirmation for Playwright panels', async () => {
    const button = { click: vi.fn() }
    const dialog = { isVisible: vi.fn().mockResolvedValue(true), getByRole: vi.fn().mockReturnValue(button) }
    const page = { getByRole: vi.fn().mockReturnValue(dialog) }
    const press = vi.fn()
    expect(await confirmTradeAcceptance({ page, press })).toBe(true)
    expect(page.getByRole).toHaveBeenCalledWith('dialog', { name: 'Accept trade?', exact: true })
    expect(dialog.getByRole).toHaveBeenCalledWith('button', { name: 'Accept', exact: true })
    expect(press).toHaveBeenCalledExactlyOnceWith(button)
  })
})
