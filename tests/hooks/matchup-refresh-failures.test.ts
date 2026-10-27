import { boundary, held, bumpView } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
beforeEach(() => { boundary.read.mockImplementation(async scope => homePayload(String(scope.params.date))) })
it('keeps the last lineup after a background failure and clears retry state on recovery', async () => {
    await h.render()
    const previous = h.latest.myLineup
    boundary.read.mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(async () => { await bumpView() })
    expect(h.latest.myLineup).toBe(previous)
    expect(h.latest.lineupError).toBe(true)
    await act(async () => { await h.latest.refreshSilently() })
    expect(h.latest.lineupError).toBe(false)
})
it('consumes an old owner failure without altering the current owner', async () => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render()
    await h.render({ member: 'new' })
    await act(async () => { await old.reject(new Error('old request failed')) })
    expect(h.latest.error).toBeNull()
    expect(h.latest.myLineup).not.toBeNull()
})
it('shows retry for an uncached offline day and clears it after reconnect', async () => {
    await h.render(); boundary.online = false; await h.render()
    await act(async () => { h.latest.setSelectedDate('2026-10-29') })
    expect(h.latest.selectedDate).toBe('2026-10-29')
    expect(h.latest.myLineup).toBeNull()
    expect(h.latest.lineupLoading).toBe(false)
    expect(h.latest.lineupError).toBe(true)
    expect(boundary.read).toHaveBeenCalledOnce()
    boundary.online = true
    await h.render()
    await act(async () => { await window.dispatchEvent(new Event('online')) })
    await h.render()
    expect(h.latest.myLineup?.bench[0].playerId).toBe('2026-10-29')
    expect(h.latest.lineupError).toBe(false)
})
