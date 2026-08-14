import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeagueInfo } from '@/types/app'
import { useCommissionerAdminActions } from '@/hooks/use-commissioner-admin-actions'
import { useCommissionerSettingsResource } from '@/hooks/use-commissioner-settings-resource'
import { useCommissionerOverrides } from '@/hooks/use-commissioner-overrides'

const mocks = vi.hoisted(() => ({
    apiPost: vi.fn(),
    getLeagueMembers: vi.fn(),
    getLineupSlots: vi.fn(),
    updateLeagueConfiguration: vi.fn(),
    adjustFaabBalance: vi.fn(),
    overrideWeeklyAddCount: vi.fn(),
    showAlert: vi.fn(),
    showSuccess: vi.fn(),
}))

vi.mock('@/lib/league', () => ({
    adjustFaabBalance: mocks.adjustFaabBalance,
    deleteLeague: vi.fn(),
    getLeagueMembers: mocks.getLeagueMembers,
    getLineupSlots: mocks.getLineupSlots,
    overrideWeeklyAddCount: mocks.overrideWeeklyAddCount,
    updateLeagueConfiguration: mocks.updateLeagueConfiguration,
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/rookieDraft', () => ({ advanceSeason: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/constants/tokens', () => ({ colors: { danger: '#f00', primaryDark: '#000' } }))
vi.mock('@/lib/alert', () => ({
    confirmAction: vi.fn(),
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    showAlert: mocks.showAlert,
    showSuccess: mocks.showSuccess,
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
                ownerId: 'user',
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
                ownerId: 'user',
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

    it('synchronously serializes saves and ignores completion after owner identity changes', async () => {
        mocks.getLineupSlots.mockResolvedValue([])
        const update = deferred<void>()
        mocks.updateLeagueConfiguration.mockReturnValue(update.promise)
        const refresh = vi.fn(async () => undefined)
        const onSaved = vi.fn()
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = ({ ownerId, value }: { ownerId: string; value: LeagueInfo }) => {
            latest = useCommissionerSettingsResource({
                league: value,
                ownerId,
                isCommissioner: true,
                refresh,
                onSaved,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(Probe, { ownerId: 'user-a', value: league('a') }))
            await Promise.resolve()
        })
        await act(async () => { latest.updateField('rosterSize', '22') })
        let first!: Promise<void>
        await act(async () => {
            first = latest.save()
            void latest.save()
            await Promise.resolve()
        })
        expect(mocks.updateLeagueConfiguration).toHaveBeenCalledOnce()

        await act(async () => {
            renderer.update(React.createElement(Probe, { ownerId: 'user-b', value: league('b') }))
        })
        expect(latest.saving).toBe(false)
        await act(async () => { update.resolve(); await first })
        expect(refresh).not.toHaveBeenCalled()
        expect(onSaved).not.toHaveBeenCalled()
        expect(latest.saving).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('does not carry an unsaved draft to a different owner in the same league', async () => {
        mocks.getLineupSlots.mockResolvedValue([])
        const testLeague = league('shared', 20)
        let latest!: ReturnType<typeof useCommissionerSettingsResource>
        const Probe = ({ ownerId }: { ownerId: string }) => {
            latest = useCommissionerSettingsResource({
                league: testLeague,
                ownerId,
                isCommissioner: true,
                refresh: vi.fn(),
                onSaved: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(Probe, { ownerId: 'user-a' }))
            await Promise.resolve()
        })
        await act(async () => { latest.updateField('rosterSize', '99') })

        await act(async () => {
            renderer.update(React.createElement(Probe, { ownerId: 'user-b' }))
            await Promise.resolve()
        })

        expect(latest.draft.rosterSize).toBe('20')
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
            latest = useCommissionerAdminActions({ ownerId: 'user', league: testLeague, refresh: vi.fn(), onDeleted: vi.fn() })
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

    it('always scopes schedule generation to the active league', async () => {
        mocks.apiPost.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useCommissionerAdminActions>
        const Probe = () => {
            latest = useCommissionerAdminActions({ ownerId: 'user', league: league('league-a'), refresh: vi.fn(), onDeleted: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const generate = latest.lifecycle.actions.find((action) => action.id === 'generate-schedule')

        await act(async () => { await generate?.onPress() })

        expect(mocks.apiPost).toHaveBeenCalledWith('/sync/matchups', {
            force: false,
            leagueId: 'league-a',
        })
        await act(async () => { renderer.unmount() })
    })

    it('ignores admin completion after authenticated league ownership changes', async () => {
        const first = deferred<void>()
        mocks.apiPost.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined)
        let latest!: ReturnType<typeof useCommissionerAdminActions>
        const Probe = ({ ownerId, leagueId }: { ownerId: string; leagueId: string }) => {
            latest = useCommissionerAdminActions({
                ownerId,
                league: league(leagueId),
                refresh: vi.fn(),
                onDeleted: vi.fn(),
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { ownerId: 'user-a', leagueId: 'a' })) })
        const oldAction = latest.lowerPriorityActions.find((action) => action.id === 'process-waivers')
        let oldRequest!: Promise<void>
        await act(async () => { oldRequest = oldAction?.onPress() as Promise<void>; await Promise.resolve() })

        await act(async () => {
            renderer.update(React.createElement(Probe, { ownerId: 'user-b', leagueId: 'b' }))
        })
        expect(latest.busyAction).toBeNull()
        const newAction = latest.lowerPriorityActions.find((action) => action.id === 'process-waivers')
        await act(async () => { await newAction?.onPress() })
        expect(mocks.showSuccess).toHaveBeenCalledTimes(1)

        await act(async () => { first.resolve(); await oldRequest })
        expect(mocks.showSuccess).toHaveBeenCalledTimes(1)
        expect(latest.busyAction).toBeNull()
        await act(async () => { renderer.unmount() })
    })
})

describe('commissioner overrides', () => {
    it('rejects partial and unsafe integer strings without mutating league state', async () => {
        let latest!: ReturnType<typeof useCommissionerOverrides>
        const Probe = () => {
            latest = useCommissionerOverrides('user', 'league', [{ id: 'member' }])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        for (const malformed of ['12abc', '1.5', '9007199254740992']) {
            await act(async () => { latest.setOverrideFaab(malformed) })
            await act(async () => { await latest.handleFaabOverride() })
        }

        expect(mocks.adjustFaabBalance).not.toHaveBeenCalled()
        expect(mocks.showAlert).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })

    it('accepts a full non-negative integer string', async () => {
        mocks.adjustFaabBalance.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useCommissionerOverrides>
        const Probe = () => {
            latest = useCommissionerOverrides('user', 'league', [{ id: 'member' }])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.setOverrideFaab('12') })
        await act(async () => { await latest.handleFaabOverride() })

        expect(mocks.adjustFaabBalance).toHaveBeenCalledWith('league', 'member', 12)
        await act(async () => { renderer.unmount() })
    })

    it('does not clear new-owner override fields when an old mutation completes', async () => {
        const oldUpdate = deferred<void>()
        mocks.adjustFaabBalance.mockReturnValueOnce(oldUpdate.promise)
        let latest!: ReturnType<typeof useCommissionerOverrides>
        const Probe = ({ ownerId, leagueId }: { ownerId: string; leagueId: string }) => {
            latest = useCommissionerOverrides(ownerId, leagueId, [{ id: `member-${leagueId}` }])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { ownerId: 'user-a', leagueId: 'a' })) })
        await act(async () => { latest.setOverrideFaab('12') })
        let pending!: Promise<unknown>
        await act(async () => { pending = latest.handleFaabOverride(); await Promise.resolve() })

        await act(async () => {
            renderer.update(React.createElement(Probe, { ownerId: 'user-b', leagueId: 'b' }))
            await Promise.resolve()
        })
        await act(async () => { latest.setOverrideFaab('9') })
        await act(async () => { oldUpdate.resolve(); await pending })

        expect(latest.overrideFaab).toBe('9')
        expect(latest.overrideSaving).toBe(false)
        expect(mocks.showSuccess).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})
