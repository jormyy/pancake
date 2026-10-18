import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeagueInfo } from '@/types/app'
import { useCommissionerSettingsResource } from '@/hooks/use-commissioner-settings-resource'
import { useCommissionerAdminActions } from '@/hooks/use-commissioner-admin-actions'
import { useCommissionerOverrides } from '@/hooks/use-commissioner-overrides'
import { setSessionOwner } from '@/lib/session-cache-registry'

const mocks = vi.hoisted(() => ({
    getLineupSlots: vi.fn(), getLeagueMembers: vi.fn(), getLeaguePlayoffCalendar: vi.fn(), fetchUserLeagues: vi.fn(),
    updateLeagueConfiguration: vi.fn(), deleteLeague: vi.fn(),
    adjustFaabBalance: vi.fn(), overrideWeeklyAddCount: vi.fn(), apiPost: vi.fn(),
    showAlert: vi.fn(), showSuccess: vi.fn(), confirmAction: vi.fn(),
    focused: true, visible: true, online: true,
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused }))
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }))
vi.mock('@/lib/league', () => ({
    fetchUserLeagues: mocks.fetchUserLeagues,
    getLineupSlots: mocks.getLineupSlots,
    getLeagueMembers: mocks.getLeagueMembers,
    getLeaguePlayoffCalendar: mocks.getLeaguePlayoffCalendar,
    updateLeagueConfiguration: mocks.updateLeagueConfiguration,
    deleteLeague: mocks.deleteLeague,
    adjustFaabBalance: mocks.adjustFaabBalance,
    overrideWeeklyAddCount: mocks.overrideWeeklyAddCount,
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/rookieDraft', () => ({ advanceSeason: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/constants/tokens', () => ({ colors: { danger: '#f00', primaryDark: '#000' } }))
vi.mock('@/lib/alert', () => ({
    showAlert: mocks.showAlert, showSuccess: mocks.showSuccess, confirmAction: mocks.confirmAction,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixture: LeagueInfo = {
    id: 'league-a', name: 'Synthetic league', invite_code: null, status: 'setup',
    commissioner_id: 'user-a', auction_budget: 200, scoring_settings: { points: 1 },
    playoff_start_week: 20, roster_size: 20, ir_slots: 2, taxi_slots: 0,
    weekly_add_limit: 0, waiver_mode: 'faab', faab_starting_budget: 100,
    trade_veto_mode: 'member_vote', trade_veto_window_hours: 24, trade_veto_threshold_percent: 50,
}
const deferred = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

beforeEach(() => {
    vi.resetAllMocks()
    setSessionOwner('user-a')
    mocks.focused = true
    mocks.visible = true
    mocks.online = true
    const page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => mocks.visible ? 'visible' : 'hidden' })
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { get onLine() { return mocks.online } })
    mocks.fetchUserLeagues.mockResolvedValue([{ id: 'member-a', role: 'commissioner', leagues: fixture }])
    mocks.getLineupSlots.mockResolvedValue([])
    mocks.getLeagueMembers.mockResolvedValue([{ id: 'member-a', team_name: 'Synthetic team' }])
    mocks.getLeaguePlayoffCalendar.mockResolvedValue({ seasonYear: 2027, weeks: [20, 21, 22] })
    mocks.updateLeagueConfiguration.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('originating screen lifetime', () => {
    it.each(['update', 'refresh'] as const)('does not close a new screen after unmount during %s', async (phase) => {
        const update = deferred()
        const refreshResult = deferred()
        const refreshEntered = deferred()
        mocks.updateLeagueConfiguration.mockReturnValue(update.promise)
        const refresh = vi.fn(() => {
            refreshEntered.resolve()
            return refreshResult.promise
        })
        const onSaved = vi.fn()
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({ league: fixture, ownerId: 'user-a',
                isCommissioner: true, refresh, onSaved })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.loadState).toBe('ready')
        expect(latest.authorityReady).toBe(true)
        await act(async () => { latest.updateField('rosterSize', '22') })
        let pending!: Promise<void>
        await act(async () => { pending = latest.save() })
        expect(mocks.updateLeagueConfiguration).toHaveBeenCalledWith('league-a', { roster_size: 22 }, null)
        if (phase === 'refresh') {
            await act(async () => { update.resolve(); await refreshEntered.promise })
            expect(refresh).toHaveBeenCalledOnce()
        }
        await act(async () => { renderer.unmount() })
        await act(async () => {
            update.resolve()
            refreshResult.resolve()
            await pending
        })
        expect(refresh).toHaveBeenCalledTimes(phase === 'refresh' ? 1 : 0)
        expect(onSaved).not.toHaveBeenCalled()
        expect(mocks.showAlert).not.toHaveBeenCalled()
    })

    it('keeps an authorized mounted save working', async () => {
        const refresh = vi.fn(async () => undefined)
        const onSaved = vi.fn()
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({ league: fixture, ownerId: 'user-a',
                isCommissioner: true, refresh, onSaved })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.authorityReady).toBe(true)
        await act(async () => { latest.updateField('rosterSize', '22') })
        await act(async () => { await latest.save() })
        expect(mocks.updateLeagueConfiguration).toHaveBeenCalledWith('league-a', { roster_size: 22 }, null)
        expect(refresh).toHaveBeenCalledOnce()
        expect(onSaved).toHaveBeenCalledOnce()
        expect(mocks.fetchUserLeagues).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })

    it.each(['hidden', 'offline', 'unfocused'] as const)('keeps the real activity gate closed while %s', async state => {
        mocks.visible = state !== 'hidden'
        mocks.online = state !== 'offline'
        mocks.focused = state !== 'unfocused'
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({ league: fixture, ownerId: 'user-a',
                isCommissioner: true, refresh: vi.fn(), onSaved: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.save() })
        expect(latest.authorityReady).toBe(false)
        expect(mocks.fetchUserLeagues).not.toHaveBeenCalled()
        expect(mocks.updateLeagueConfiguration).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('refuses a save after fresh commissioner membership is removed', async () => {
        const onSaved = vi.fn()
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({ league: fixture, ownerId: 'user-a',
                isCommissioner: true, refresh: vi.fn(), onSaved })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.authorityReady).toBe(true)
        await act(async () => { latest.updateField('rosterSize', '22') })
        mocks.fetchUserLeagues.mockResolvedValue([])
        await act(async () => { await latest.save() })
        expect(latest.loadState).toBe('unauthorized')
        expect(mocks.updateLeagueConfiguration).not.toHaveBeenCalled()
        expect(onSaved).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('does not show a save error after unmount', async () => {
        const response = deferred()
        mocks.updateLeagueConfiguration.mockReturnValue(response.promise)
        const refresh = vi.fn(async () => undefined)
        const onSaved = vi.fn()
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({ league: fixture, ownerId: 'user-a',
                isCommissioner: true, refresh, onSaved })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.updateField('rosterSize', '22') })
        let pending!: Promise<void>
        await act(async () => { pending = latest.save() })
        expect(mocks.updateLeagueConfiguration).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
        await act(async () => { response.reject(new Error('Synthetic failure')); await pending })
        expect(refresh).not.toHaveBeenCalled()
        expect(onSaved).not.toHaveBeenCalled()
        expect(mocks.showAlert).not.toHaveBeenCalled()
    })

    it.each(['success', 'error'] as const)('ignores admin %s feedback after unmount', async (outcome) => {
        const response = deferred()
        mocks.apiPost.mockReturnValue(response.promise)
        let latest!: ReturnType<typeof useCommissionerAdminActions>
        const Probe = () => {
            latest = useCommissionerAdminActions({ league: fixture, ownerId: 'user-a',
                refresh: vi.fn(async () => undefined), onDeleted: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const action = latest.lifecycle.actions.find((item) => item.id === 'generate-schedule')
        expect(action).toBeDefined()
        let pending!: void | Promise<void>
        await act(async () => { pending = action!.onPress() })
        expect(mocks.apiPost).toHaveBeenCalledWith('/sync/matchups', { force: false, leagueId: 'league-a' })
        await act(async () => { renderer.unmount() })
        await act(async () => {
            if (outcome === 'success') response.resolve()
            else response.reject(new Error('Synthetic failure'))
            await pending
        })
        expect(mocks.showSuccess).not.toHaveBeenCalled()
        expect(mocks.showAlert).not.toHaveBeenCalled()
    })

    it.each(['success', 'error'] as const)('ignores override %s feedback after unmount', async (outcome) => {
        const response = deferred()
        mocks.adjustFaabBalance.mockReturnValue(response.promise)
        let latest!: ReturnType<typeof useCommissionerOverrides>
        const members = [{ id: 'member-a' }]
        const Probe = () => {
            latest = useCommissionerOverrides('user-a', 'league-a', members)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.setOverrideFaab('12') })
        let pending!: Promise<unknown>
        await act(async () => { pending = latest.handleFaabOverride() })
        expect(mocks.adjustFaabBalance).toHaveBeenCalledWith('league-a', 'member-a', 12)
        await act(async () => { renderer.unmount() })
        await act(async () => {
            if (outcome === 'success') response.resolve()
            else response.reject(new Error('Synthetic failure'))
            await pending
        })
        expect(mocks.showSuccess).not.toHaveBeenCalled()
        expect(mocks.showAlert).not.toHaveBeenCalled()
    })
})
