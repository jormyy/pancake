import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
beforeEach(() => { boundary.read.mockImplementation(async scope => homePayload(String(scope.params.date))) })
it.each(['hidden', 'offline', 'inactive'] as const)('defers %s reads and catches up on resume', async mode => {
    boundary.hidden = mode === 'hidden'; boundary.online = mode !== 'offline'; boundary.focused = mode !== 'inactive'
    await h.render()
    expect(boundary.read).not.toHaveBeenCalled()
    boundary.hidden = false; boundary.online = true; boundary.focused = true
    await h.render()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')) })
    await h.render()
    expect(boundary.read).toHaveBeenCalledOnce()
    expect(h.latest.matchup?.myPoints).toBe(4)
})
it('retains a valid offline view without starting reads', async () => {
    await h.render(); await h.unmount(); boundary.online = false
    await h.render()
    expect(h.latest.myLineup?.benchSlots).toBe(1)
    expect(boundary.read).toHaveBeenCalledOnce()
})
it('rejects missing offline views and recovers after reconnect', async () => {
    boundary.online = false
    await h.render()
    expect(h.surface()).toBe('error')
    boundary.online = true
    await act(async () => { await window.dispatchEvent(new Event('online')) })
    await h.render()
    expect(h.surface()).toBe('matchup')
})
it('reuses an unchanged route and catches up a hidden lineup change', async () => {
    await h.render(); boundary.focused = false; await h.render(); boundary.focused = true; await h.render()
    expect(boundary.read).toHaveBeenCalledOnce()
    boundary.hidden = true
    await act(async () => { await document.dispatchEvent(new Event('visibilitychange')) })
    boundary.read.mockResolvedValue(homePayload(undefined, 9))
    await act(async () => { await bumpView('league', 'lineup') })
    expect(boundary.read).toHaveBeenCalledOnce()
    boundary.hidden = false
    await act(async () => { await document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.latest.matchup?.myPoints).toBe(9)
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
it.each(['hidden', 'offline', 'inactive'] as const)('rejects a held response after %s suspension and reads fresh on resume', async mode => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(homePayload(undefined, 12))
    await h.render()
    boundary.hidden = mode === 'hidden'; boundary.online = mode !== 'offline'; boundary.focused = mode !== 'inactive'
    await act(async () => { await document.dispatchEvent(new Event('visibilitychange')) })
    await h.render()
    boundary.hidden = false; boundary.online = true; boundary.focused = true
    await h.render()
    await act(async () => { await document.dispatchEvent(new Event('visibilitychange')) })
    await h.render()
    expect(h.latest.matchup?.myPoints).toBe(12)
    await act(async () => { await old.resolve(homePayload(undefined, 4)) })
    expect(h.latest.matchup?.myPoints).toBe(12)
})
it('keeps inactive routes silent on browser resume and explicit refresh', async () => {
    await h.render(); boundary.focused = false; await h.render()
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); await h.latest.refresh(); await h.latest.refreshSilently() })
    expect(boundary.read).toHaveBeenCalledOnce()
})
it('rejects held results from a former session generation', async () => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(homePayload(undefined, 20))
    await h.render(); boundary.generation += 1
    await h.render()
    await act(async () => { await old.resolve(homePayload(undefined, 1)) })
    expect(h.latest.matchup?.myPoints).toBe(20)
})
it('revalidates configured capacity on a settings version', async () => {
    await h.render()
    const next = homePayload(); next.myLineup!.benchSlots = 0
    boundary.read.mockResolvedValue(next)
    await act(async () => { await bumpView('league', 'settings') })
    expect(h.latest.myLineup?.benchSlots).toBe(0)
})
