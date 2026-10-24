import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LineupScreen from '@/app/(modals)/lineup'

const mocks = vi.hoisted(() => ({
    context: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' }, online: true },
    savePreference: vi.fn(), enabled: false, setEnabled: vi.fn(), autoSet: vi.fn(), showAlert: vi.fn(),
}))
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Switch: 'Switch', StyleSheet: { create: (v: unknown) => v } }))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => mocks.context }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-lineup-actions', () => ({ useLineupActions: () => ({
    selected: null, setSelected: vi.fn(), saving: false, autoSetting: false, autoSetModalVisible: true,
    setAutoSetModalVisible: vi.fn(), handleTap: vi.fn(), doAutoSet: mocks.autoSet, handleAutoSet: vi.fn(),
}) }))
vi.mock('@/hooks/use-live-stats', () => ({ useLiveStats: () => ({ startedTeams: new Set(), liveTeams: new Set(), teamMatchups: new Map() }) }))
vi.mock('@/lib/lineup', () => ({
    clampDateToWeek: (date: string) => date,
    getLineupContext: async (league: string) => ({ seasonId: `season-${league}`, weekNumber: 1, seasonYear: 2027, today: '2026-10-11' }),
    getWeekDays: async () => [{ date: '2026-10-11', playingTeams: [] }],
    getWeeklyLineup: async () => ({ starters: [], bench: [] }), getLineupMoveTargetState: () => null,
}))
vi.mock('@/lib/lineup/optimizerSettings', () => ({ getLineupOptimizerEnabled: async () => mocks.enabled, setLineupOptimizerEnabled: mocks.setEnabled }))
vi.mock('@/lib/lineup/snapshot', () => ({ readLineupSnapshot: () => null, saveLineupSnapshot: vi.fn(), discardLineupSnapshot: vi.fn(), updateLineupOptimizerSnapshot: mocks.savePreference }))
vi.mock('@/lib/supabase', () => ({ readStoredAuthState: () => ({ session: { user: { id: 'user' } } }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => 1, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-11', endOfETDayUTC: () => '2026-10-12T04:00:00Z' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ debounceRealtimeRefresh: () => ({ trigger: vi.fn() }), disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.showAlert }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => '' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/DaySelector', () => ({ DaySelector: 'DaySelector' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/Badge', () => ({ InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable', MotionView: 'MotionView' }))
vi.mock('@/components/ui', () => ({ Button: 'Button', Page: 'Page', PageHeader: 'PageHeader', usePageMetrics: () => ({ padX: 16, usableWidth: 1000, compact: false }) }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const toggle = () => screen.root.findByType('Switch' as React.ElementType)
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
    mocks.context.current = { id: 'member-a' }; mocks.context.currentLeague = { id: 'league-a' }; mocks.enabled = false
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { screen = create(React.createElement(LineupScreen)) }) }

it.each([true, false])('keeps a delayed setting reply from changing another league when enabling=%s', async (enabling) => {
    let finish!: () => void
    mocks.setEnabled.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    mocks.enabled = !enabling
    await mount()
    let pending!: Promise<void>
    await act(async () => { pending = toggle().props.onValueChange(enabling) })
    mocks.context.current = { id: 'member-b' }; mocks.context.currentLeague = { id: 'league-b' }
    await act(async () => { screen.update(React.createElement(LineupScreen)) })
    expect(toggle().props.value).toBe(!enabling)
    await act(async () => { finish(); await pending })
    expect(toggle().props.value).toBe(!enabling)
    expect(mocks.autoSet).toHaveBeenCalledTimes(0)
})

it.each(['switch', 'unmount'] as const)('does not show a late settings failure after %s', async (action) => {
    let fail!: (error: Error) => void
    mocks.setEnabled.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject }))
    await mount()
    let pending!: Promise<void>
    await act(async () => { pending = toggle().props.onValueChange(true) })
    if (action === 'switch') {
        mocks.context.current = { id: 'member-b' }; mocks.context.currentLeague = { id: 'league-b' }
        await act(async () => { screen.update(React.createElement(LineupScreen)) })
    } else await act(async () => screen.unmount())
    await act(async () => { fail(new Error('old settings failed')); await pending })
    expect(mocks.showAlert).not.toHaveBeenCalled()
    expect(mocks.autoSet).not.toHaveBeenCalled()
})

it('updates the current setting without changing manual lineups', async () => {
    mocks.setEnabled.mockResolvedValueOnce(undefined)
    await mount()
    await act(async () => { await toggle().props.onValueChange(true) })
    expect(toggle().props.value).toBe(true)
    expect(mocks.setEnabled).toHaveBeenCalledWith('member-a', 'league-a', 'season-league-a', true)
    expect(mocks.savePreference).toHaveBeenCalledWith({ ownerId: 'user', memberId: 'member-a', leagueId: 'league-a', day: '2026-10-11' }, 1, 'season-league-a', true)
    expect(mocks.autoSet).not.toHaveBeenCalled()
})


it('turns the current team on and off without running a manual action', async () => {
    mocks.setEnabled.mockResolvedValue(undefined)
    await mount()
    expect(toggle().props.value).toBe(false)
    await act(async () => { await toggle().props.onValueChange(true) })
    expect(toggle().props.value).toBe(true)
    await act(async () => { await toggle().props.onValueChange(false) })
    expect(toggle().props.value).toBe(false)
    expect(mocks.setEnabled.mock.calls).toEqual([
        ['member-a', 'league-a', 'season-league-a', true],
        ['member-a', 'league-a', 'season-league-a', false],
    ])
    expect(mocks.autoSet).not.toHaveBeenCalled()
})

it('keeps the saved preference when the current write fails', async () => {
    mocks.setEnabled.mockRejectedValueOnce(new Error('connection failed'))
    await mount()
    await act(async () => { await toggle().props.onValueChange(true) })
    expect(toggle().props.value).toBe(false)
    expect(toggle().props.disabled).toBe(false)
    expect(mocks.showAlert).toHaveBeenCalledWith('Auto-set daily failed', 'connection failed')
})
