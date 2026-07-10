import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeagueInfo } from '@/types/app'
import { useCommissionerAdminActions } from '@/hooks/use-commissioner-admin-actions'
import { useCommissionerSettingsResource } from '@/hooks/use-commissioner-settings-resource'

const mocks = vi.hoisted(() => ({
    apiPost: vi.fn(),
    getLeagueMembers: vi.fn(),
    getLineupSlots: vi.fn(),
    updateLeagueConfiguration: vi.fn(),
}))

vi.mock('@/lib/league', () => ({
    adjustFaabBalance: vi.fn(),
    deleteLeague: vi.fn(),
    getLeagueMembers: mocks.getLeagueMembers,
    getLineupSlots: mocks.getLineupSlots,
    overrideWeeklyAddCount: vi.fn(),
    updateLeagueConfiguration: mocks.updateLeagueConfiguration,
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/rookieDraft', () => ({ advanceSeason: vi.fn() }))
vi.mock('@/constants/tokens', () => ({ colors: { danger: '#f00', primaryDark: '#000' } }))
vi.mock('@/lib/alert', () => ({
    confirmAction: vi.fn(),
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    showAlert: vi.fn(),
    showSuccess: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const league = (id: string, rosterSize = 20): LeagueInfo => ({
    id,
    name: `League ${id}`,
    invite_code: null,
    status: 'setup',
    commissioner_id: 'commissioner',
    auction_budget: 200,
    scoring_settings: { points: 1 },
    playoff_start_week: 20,
    roster_size: rosterSize,
    ir_slots: 2,
    taxi_slots: 0,
    weekly_add_limit: 0,
    waiver_mode: 'faab',
    faab_starting_budget: 100,
    trade_veto_mode: 'member_vote',
    trade_veto_window_hours: 24,
    trade_veto_threshold_percent: 50,
})

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLeagueMembers.mockResolvedValue([{ id: 'member', team_name: 'Team' }])
    mocks.updateLeagueConfiguration.mockResolvedValue(undefined)
})

describe('commissioner settings resource', () => {
    it('ignores a stale settings load after the league changes', async () => {
        const first = deferred<never[]>()
        const second = deferred<never[]>()
        mocks.getLineupSlots.mockImplementation((leagueId: string) =>
            leagueId === 'a' ? first.promise : second.promise)
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = ({ value }: { value: LeagueInfo }) => {
            latest = useCommissionerSettingsResource({
                league: value,
                isCommissioner: true,
                refresh: vi.fn(),
                onSaved: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { value: league('a', 18) })) })
        await act(async () => { renderer.update(React.createElement(Probe, { value: league('b', 24) })) })
        await act(async () => { second.resolve([]); await second.promise })
        expect(latest.draft.rosterSize).toBe('24')
        await act(async () => { first.resolve([]); await first.promise })
        expect(latest.draft.rosterSize).toBe('24')
        await act(async () => { renderer.unmount() })
    })

    it('persists only the edited settings and refreshes before closing', async () => {
        mocks.getLineupSlots.mockResolvedValue([])
        const refresh = vi.fn(async () => undefined)
        const onSaved = vi.fn()
        const testLeague = league('league')
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = () => {
            latest = useCommissionerSettingsResource({
                league: testLeague,
                isCommissioner: true,
                refresh,
                onSaved,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { latest.updateField('rosterSize', '22') })
        await act(async () => { await latest.save() })
        expect(mocks.updateLeagueConfiguration).toHaveBeenCalledWith(
            'league',
            { roster_size: 22 },
            null,
        )
        expect(refresh).toHaveBeenCalledOnce()
        expect(onSaved).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })
})

describe('commissioner admin actions', () => {
    it('exposes action progress while the canonical API request is in flight', async () => {
        const request = deferred<void>()
        mocks.apiPost.mockReturnValue(request.promise)
        const testLeague = league('league')
        let latest!: ReturnType<typeof useCommissionerAdminActions>
        const Probe = () => {
            latest = useCommissionerAdminActions({ league: testLeague, refresh: vi.fn(), onDeleted: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const processWaivers = latest.lowerPriorityActions.find((action) => action.id === 'process-waivers')
        expect(processWaivers).toBeDefined()
        let pending: void | Promise<void> = undefined
        await act(async () => { pending = processWaivers?.onPress(); await Promise.resolve() })
        expect(latest.busyAction).toBe('process-waivers')
        expect(mocks.apiPost).toHaveBeenCalledWith('/waivers/process', {})
        await act(async () => { request.resolve(); await pending })
        expect(latest.busyAction).toBeNull()
        await act(async () => { renderer.unmount() })
    })
})
