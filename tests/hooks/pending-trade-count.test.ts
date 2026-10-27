import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { clearScreenViews, saveScreenView, type ScreenScope } from '@/lib/cache/screen-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({ owner: 'account', league: 'league', reads: vi.fn() }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: state.league } }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: state.owner ? { id: state.owner } : null }) }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: state.reads, rpc: state.reads } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
let count = -1
const frames: number[] = []
const Probe = () => { count = usePendingTradeCount(); frames.push(count); return null }
const scope = (changes: Partial<ScreenScope> = {}): ScreenScope => ({ accountId: 'account', leagueId: 'league', memberId: 'member', screen: 'home', ...changes })
const save = (value: number, changes: Partial<ScreenScope> = {}) => saveScreenView(scope(changes), { context: { pendingIncomingCount: value } }, '1')
const mount = async () => { await act(async () => { screen = create(React.createElement(Probe)) }) }
beforeEach(() => { state.owner = 'account'; state.league = 'league'; setSessionOwner('account'); clearScreenViews(); frames.length = 0; vi.clearAllMocks() })
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })

it('shows a saved server count in the first frame without a separate count read', async () => {
    save(3)
    await mount()
    expect(frames[0]).toBe(3)
    expect(state.reads).not.toHaveBeenCalled()
})

it('updates mounted badges when a refreshed view publishes the next count', async () => {
    save(3)
    await mount()
    await act(async () => save(7))
    expect(count).toBe(7)
})

it('uses the current league immediately when the selected league changes', async () => {
    save(3)
    save(5, { leagueId: 'other' })
    await mount()
    state.league = 'other'
    frames.length = 0
    await act(async () => screen!.update(React.createElement(Probe)))
    expect(frames).toEqual([5])
})

it('never displays another account count after an account switch', async () => {
    save(9)
    await mount()
    state.owner = 'next'
    await act(async () => { setSessionOwner('next'); screen!.update(React.createElement(Probe)) })
    expect(count).toBe(0)
    await act(async () => save(4, { accountId: 'next' }))
    expect(count).toBe(4)
})

it('clears a displayed count when the session caches clear', async () => {
    save(9)
    await mount()
    await act(async () => clearScreenViews())
    expect(count).toBe(0)
})

it('keeps the saved count through unrelated view publications and a remount', async () => {
    save(6)
    await mount()
    await act(async () => save(20, { leagueId: 'other' }))
    expect(count).toBe(6)
    await act(async () => screen!.unmount())
    await mount()
    expect(count).toBe(6)
})

it('shows zero when signed out even if another owner has cached views', async () => {
    save(8)
    state.owner = ''
    await mount()
    expect(count).toBe(0)
})
