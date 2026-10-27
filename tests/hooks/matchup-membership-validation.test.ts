import { boundary, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { saveScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { todayET } from '@/lib/shared/dates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
const empty = () => ({ ...homePayload(), matchup: null })
beforeEach(() => { boundary.read.mockResolvedValue(empty()) })
it('waits for membership validation before confirming a fresh empty answer', async () => {
    await h.render({ validated: false })
    await act(async () => { await h.latest.refresh() })
    expect(boundary.read).not.toHaveBeenCalled()
    expect(h.latest.emptyConfirmed).toBe(false)
    expect(h.surface()).toBe('loading')
    await h.render()
    expect(h.latest.emptyConfirmed).toBe(true)
    expect(h.surface()).toBe('empty')
})
it.each([null, homePayload().matchup])('restores the authorized cached answer %j during revalidation', async matchup => {
    saveScreenView(screenScope('home', 'league', 'member', { date: todayET() }, 'account'), { ...homePayload(), matchup }, '1')
    await h.render({ validated: false })
    expect(boundary.read).not.toHaveBeenCalled()
    expect(h.surface()).toBe(matchup ? 'matchup' : 'empty')
})
it.each(['before', 'after'])('shows membership failure %s a cached empty answer', async order => {
    if (order === 'after') await h.render()
    await h.render({ validated: false, error: new Error('membership unavailable') })
    expect(h.latest.emptyConfirmed).toBe(false)
    expect(h.surface()).toBe('error')
})
it('retries membership before admitting the view and recovers', async () => {
    const check = held<void>(), retry = vi.fn(() => check.promise)
    await h.render({ validated: false, error: new Error('membership unavailable'), retry })
    let request!: Promise<void>
    await act(async () => { request = h.latest.refresh() })
    expect(retry).toHaveBeenCalledOnce()
    expect(boundary.read).not.toHaveBeenCalled()
    boundary.read.mockResolvedValue(homePayload())
    await h.render({ retry })
    await act(async () => { check.resolve(); await request })
    expect(h.surface()).toBe('matchup')
    expect(h.latest.error).toBeNull()
})
it('keeps confirmed empty visible throughout a pending refresh', async () => {
    await h.render()
    const next = held<ReturnType<typeof empty>>()
    boundary.read.mockReturnValueOnce(next.promise)
    let request!: Promise<void>
    await act(async () => { request = h.latest.refresh() })
    expect(h.surface()).toBe('empty')
    await act(async () => { next.resolve(empty()); await request })
    expect(h.surface()).toBe('empty')
})
it('does not let a former membership retry cancel the new membership read', async () => {
    const check = held<void>(), next = held<ReturnType<typeof homePayload>>()
    await h.render({ validated: false, error: new Error('membership unavailable'), retry: () => check.promise })
    let request!: Promise<void>
    await act(async () => { request = h.latest.refresh() })
    boundary.read.mockReturnValueOnce(next.promise)
    await h.render({ member: 'next' })
    await act(async () => { check.resolve(); await request })
    expect(boundary.read).toHaveBeenCalledOnce()
    await act(async () => { await next.resolve({ ...homePayload(), matchup: { ...homePayload().matchup!, myMemberId: 'next' } }) })
    expect(h.latest.matchup?.myMemberId).toBe('next')
})
it('does not certify an unread null answer', async () => {
    const next = held<ReturnType<typeof empty>>()
    boundary.read.mockReturnValue(next.promise)
    await h.render()
    expect(h.latest.emptyConfirmed).toBe(false)
    await act(async () => { await next.resolve(empty()) })
    expect(h.latest.emptyConfirmed).toBe(true)
})
it('shows an authorized view failure without claiming an empty league', async () => {
    boundary.read.mockRejectedValue(new Error('view unavailable'))
    await h.render()
    expect(h.surface()).toBe('error')
    expect(h.latest.emptyConfirmed).toBe(false)
})
