import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LineupScreen from '@/app/(modals)/lineup'

const mocks = vi.hoisted(() => ({
    context: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' }, online: true },
    lineup: { starters: [] as { slotType: string; player: null }[], bench: [] as { playerId: string; displayName: string; eligiblePositions: string[]; nbaTeam: null }[], benchSlots: 3 },
    enabled: false, setEnabled: vi.fn(), autoSet: vi.fn(), showAlert: vi.fn(),
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Switch: 'Switch', StyleSheet: { create: (v: unknown) => v } }))
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
    getWeekDays: async () => [{ date: '2026-10-11', playingTeams: [] }, { date: '2026-10-12', playingTeams: [] }],
    getWeeklyLineup: async () => mocks.lineup, getLineupMoveTargetState: () => null,
}))
vi.mock('@/lib/lineup/optimizerSettings', () => ({ getLineupOptimizerEnabled: async () => mocks.enabled, setLineupOptimizerEnabled: mocks.setEnabled }))
vi.mock('@/lib/lineup/snapshot', () => ({ readLineupSnapshot: () => null, saveLineupSnapshot: vi.fn(), discardLineupSnapshot: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ readStoredAuthState: () => ({ session: { user: { id: 'user' } } }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => 1 }))
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
vi.mock('@/components/ui', () => ({ Button: 'Button', Page: 'Page', PageHeader: 'PageHeader', usePageMetrics: () => ({ padX: 16, usableWidth: 358, compact: true }) }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
    mocks.context.current = { id: 'member-a' }; mocks.context.currentLeague = { id: 'league-a' }; mocks.enabled = false
    mocks.context.online = true
    mocks.lineup = { starters: [{ slotType: 'PG', player: null }], bench: [], benchSlots: 3 }
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { screen = create(React.createElement(LineupScreen)) }) }

const emptyRows = () => screen.root.findAllByType('Text' as React.ElementType)
    .filter((node) => node.props.children === 'Empty bench slot')

it('shows each configured bench place on an entirely empty team', async () => {
    await mount()
    expect(emptyRows()).toHaveLength(3)
})

it('keeps occupied bench rows and every remaining place', async () => {
    mocks.lineup.bench = [{ playerId: 'player', displayName: 'Bench Player', eligiblePositions: ['PG'], nbaTeam: null }]
    await mount()
    expect(screen.root.findAll((node) => node.props.accessibilityLabel === 'Bench Bench Player')).toHaveLength(1)
    expect(emptyRows()).toHaveLength(2)
})

it('uses the new day capacity after switching dates', async () => {
    await mount()
    mocks.lineup = { starters: [], bench: [], benchSlots: 2 }
    await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    expect(emptyRows()).toHaveLength(2)
})

it('omits a bench section when the league has no bench places', async () => {
    mocks.lineup.benchSlots = 0
    await mount()
    expect(emptyRows()).toHaveLength(0)
    expect(screen.root.findAll((node) => node.props.accessibilityLabel === 'Bench')).toHaveLength(0)
})

it('omits starters when the league has no starter places', async () => {
    mocks.lineup.starters = []
    await mount()
    expect(screen.root.findAll((node) => node.props.accessibilityLabel === 'Starters')).toHaveLength(0)
})
