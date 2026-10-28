import { boundary, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload, lineup } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { todayET } from '@/lib/shared/dates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const writes = vi.hoisted(() => vi.fn())
vi.mock('@/lib/lineup', async original => ({ ...await original<typeof import('@/lib/lineup')>(), setPlayerSlotMoves: writes }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), showSuccess: vi.fn(), confirmAction: vi.fn() }))
let actions: ReturnType<typeof useLineupActions>
const h = homeHarness(value => { actions = useLineupActions({ actionContext: value.matchup ? { memberId: 'member', leagueId: 'league', seasonId: 'season', seasonYear: 2026, weekNumber: 1 } : null, myLineup: value.myLineup, league: { roster_size: 20 }, selectedDate: value.selectedDate, startedTeams: new Set(), reloadLineup: async () => {} }) })
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(new Date('2026-10-27T12:00:00Z')); boundary.read.mockImplementation(async scope => homePayload(String(scope.params.date))) })
it('retains a saved lineup with known zero bench capacity', async () => {
    boundary.read.mockResolvedValue({ ...homePayload(), myLineup: lineup('', 0) })
    await h.render(); await h.unmount(); boundary.online = false; await h.render()
    expect(h.latest.myLineup?.benchSlots).toBe(0)
    expect(h.latest.myLineup?.bench).toEqual([])
})
it.each(['resolve', 'reject'])('keeps the chosen date when an old refresh finishes with %s', async outcome => {
    await h.render()
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    let request!: Promise<void>
    await act(async () => { request = h.latest.refresh() })
    await act(async () => { await h.latest.setSelectedDate('2026-10-28') })
    await h.render()
    await act(async () => { if (outcome === 'resolve') old.resolve(homePayload()); else old.reject(new Error('old day failed')); await request })
    expect(h.latest.selectedDate).toBe('2026-10-28')
    expect(h.latest.myLineup?.bench[0].playerId).toBe('2026-10-28')
    expect(h.latest.error).toBeNull()
})
it.each(['loadMyLineup', 'loadLineups'] as const)('does not let an old action %s overwrite a new selection', async action => {
    await h.render()
    const previous = h.latest[action], matchup = h.latest.matchup!
    await act(async () => { await h.latest.setSelectedDate('2026-10-28') })
    await h.render()
    await act(async () => { await previous(matchup, '2026-10-27') })
    expect(h.latest.selectedDate).toBe('2026-10-28')
})
it('never shows old-day players when the chosen day fails', async () => {
    await h.render(); boundary.read.mockRejectedValueOnce(new Error('chosen day failed'))
    await act(async () => { await h.latest.setSelectedDate('2026-10-28') })
    await h.render()
    expect(h.latest.selectedDate).toBe('2026-10-28')
    expect(h.latest.myLineup).toBeNull()
    expect(h.latest.lineupError).toBe(true)
    await act(async () => { await h.latest.refresh() })
    expect(h.latest.myLineup?.bench[0].playerId).toBe('2026-10-28')
})
it('invalidates a held response when membership becomes empty', async () => {
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render(); await h.render({ member: null })
    await act(async () => { await old.resolve(homePayload()) })
    expect(h.latest.matchup).toBeNull()
    expect(h.latest.myLineup).toBeNull()
})
it.each(['member', 'league', 'owner'] as const)('hides private players on the first render after a %s change', async key => {
    await h.render(); boundary.read.mockReturnValue(new Promise(() => {})); h.frames.length = 0
    if (key === 'owner') boundary.owner = 'other'
    await h.render({ [key]: 'other' })
    expect(h.frames.length).toBeGreaterThan(0)
    expect(h.frames.every(frame => frame.myLineup === null && frame.matchup === null)).toBe(true)
})
it.each(['refresh', 'silent', 'focus', 'visibility', 'online'] as const)('rolls retained selection to the current league day on %s', async trigger => {
    await h.render(); await act(async () => { await h.latest.setSelectedDate('2026-10-28') }); await h.render()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    await act(async () => {
        if (trigger === 'refresh') await h.latest.refresh()
        else if (trigger === 'silent') await h.latest.refreshSilently()
        else if (trigger === 'visibility') document.dispatchEvent(new Event('visibilitychange'))
        else window.dispatchEvent(new Event(trigger))
    })
    await h.render()
    expect(h.latest.selectedDate).toBe('2026-10-29')
    expect(h.latest.myLineup?.bench[0].playerId).toBe('2026-10-29')
})
it('rolls over at league midnight and repeats on the next night', async () => {
    vi.setSystemTime(new Date('2026-10-28T06:59:59.900Z'))
    await h.render()
    await act(async () => { await vi.advanceTimersByTimeAsync(101) })
    expect(h.latest.selectedDate).toBe('2026-10-28')
    await act(async () => { await vi.advanceTimersByTimeAsync(86_400_000) })
    expect(h.latest.selectedDate).toBe('2026-10-29')
})
it('does not label an old held week as today after midnight', async () => {
    vi.setSystemTime(new Date('2026-10-28T06:59:59.900Z'))
    const old = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await h.render()
    await act(async () => { await vi.advanceTimersByTimeAsync(101) })
    await act(async () => { await old.resolve(homePayload('2026-10-27')) })
    expect(h.latest.selectedDate).toBe('2026-10-28')
    expect(h.latest.myLineup?.bench[0].playerId).toBe('2026-10-28')
})
it('keeps refresh authority stable for equal identity objects', async () => {
    await h.render(); const refresh = h.latest.refresh; await h.render()
    expect(h.latest.refresh).toBe(refresh)
    expect(todayET()).toBe('2026-10-27')
})

it('blocks lineup moves until the selected day arrives', async () => {
    await h.render(); writes.mockClear()
    const next = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    await act(async () => { h.latest.setSelectedDate('2026-10-28') })
    await h.render()
    expect(h.latest.myLineup).toBeNull()
    await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
    await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
    expect(writes).not.toHaveBeenCalled()
    await act(async () => { next.resolve(homePayload('2026-10-28')) })
    await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
    await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
    expect(writes).toHaveBeenCalledWith(expect.objectContaining({ gameDate: '2026-10-28' }), [{ playerId: '2026-10-28', slotType: 'PG' }])
})
