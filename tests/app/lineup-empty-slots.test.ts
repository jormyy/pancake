import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLeagueChangesConnected } from '@/lib/league-changes'
import LineupScreen, { LineupEditor } from '@/app/(modals)/lineup'
import type { LineupPlayer } from '@/lib/lineup'

const mocks = vi.hoisted(() => ({
    context: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } as { id: string; roster_size?: number; ir_slots?: number; taxi_slots?: number }, online: true, membershipValidated: false, membershipError: null as Error | null, refresh: vi.fn() },
    lineup: { starters: [] as { slotType: string; player: LineupPlayer | null }[], bench: [] as LineupPlayer[], benchSlots: 3 },
    readView: vi.fn(), hidden: false, dirty: false, listeners: new Map<() => void, string>(),
    freshness: 'fresh', games: [] as { home_team: string; away_team: string; status: string }[], startedTeams: new Set<string>(),
    enabled: false, setEnabled: vi.fn(), autoSet: vi.fn(), showAlert: vi.fn(),
}))
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Switch: 'Switch', StyleSheet: { create: (v: unknown) => v, flatten: (v: unknown) => Object.assign({}, ...[v].flat(Infinity).filter(Boolean)) } }))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => mocks.context }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-lineup-actions', () => ({ useLineupActions: () => ({
    selected: null, setSelected: vi.fn(), saving: false, autoSetting: false, autoSetModalVisible: true,
    setAutoSetModalVisible: vi.fn(), handleTap: vi.fn(), doAutoSet: mocks.autoSet, handleAutoSet: vi.fn(),
}) }))
vi.mock('@/hooks/use-live-stats', () => ({ useLiveStats: () => ({ startedTeams: mocks.startedTeams, liveTeams: new Set<string>(), todaysGames: mocks.games, freshness: mocks.freshness, teamMatchups: new Map() }) }))
vi.mock('@/lib/cache/screen-cache', () => ({
    cachedScreenView: () => ({ dirty: mocks.dirty }),
    subscribeScreenView: (scope: { leagueId: string }, listener: () => void) => { mocks.listeners.set(listener, scope.leagueId); return () => { mocks.listeners.delete(listener) } },
    readScreenView: async (scope: { leagueId: string; params: { date: string } }) => {
        const lineup = await mocks.readView(scope)
        mocks.dirty = false
        return { context: { seasonId: `season-${scope.leagueId}`, weekNumber: 1, seasonYear: 2027, today: '2026-10-11' },
            date: scope.params.date, weekDays: [{ date: '2026-10-11', playingTeams: [] }, { date: '2026-10-12', playingTeams: [] }],
            ir: [], taxi: [], ...lineup, optimizer: { enabled: mocks.enabled }, games: mocks.games, startedTeams: [...mocks.startedTeams], teamMatchups: {},
        }
    },
}))
vi.mock('@/lib/lineup', () => ({ getLineupMoveTargetState: () => null }))
vi.mock('@/lib/lineup/optimizerSettings', () => ({ getLineupOptimizerEnabled: async () => mocks.enabled, setLineupOptimizerEnabled: mocks.setEnabled }))
vi.mock('@/lib/lineup/snapshot', () => ({ readLineupSnapshot: () => null, saveLineupSnapshot: vi.fn(), discardLineupSnapshot: vi.fn(), updateLineupOptimizerSnapshot: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ readStoredAuthState: () => ({ session: { user: { id: 'user' } } }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => null, sessionGeneration: () => 1, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-11', endOfETDayUTC: () => '2026-10-12T04:00:00Z' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
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

function publishViewChange(leagueId: string, _change: unknown) {
    mocks.dirty = true
    for (const [listener, selected] of [...mocks.listeners]) if (selected === leagueId) listener()
}

describe.each([['screen', LineupScreen], ['inline', () => React.createElement(LineupEditor, { inline: true })]] as const)('%s lineup', (_mode, Component) => {
let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks(); setLeagueChangesConnected('league-a', false); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
    vi.stubGlobal('window', new EventTarget())
    const page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => mocks.hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page)
    mocks.freshness = 'fresh'; mocks.games = []; mocks.startedTeams = new Set()
    mocks.hidden = false; mocks.dirty = false; mocks.listeners.clear()
    mocks.context.current = { id: 'member-a' }; mocks.context.currentLeague = { id: 'league-a' }; mocks.enabled = false
    mocks.context.membershipValidated = false; mocks.context.membershipError = null
    mocks.context.online = true
    mocks.lineup = { starters: [{ slotType: 'PG', player: null }], bench: [], benchSlots: 3 }
    mocks.readView.mockReset().mockImplementation(async () => mocks.lineup)
})
afterEach(async () => { await act(async () => screen?.unmount()); setLeagueChangesConnected('league-a', false); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { screen = create(React.createElement(Component)) }) }

const emptyRows = () => screen.root.findAllByType('Text' as React.ElementType)
    .filter((node) => node.props.children === 'Empty bench slot')

it('shows each configured bench place on an entirely empty team', async () => {
    await mount()
    expect(emptyRows()).toHaveLength(3)
})

it('keeps occupied bench rows and every remaining place', async () => {
    mocks.lineup.bench = [{ playerId: 'player', rosterPlayerId: 'roster-player', displayName: 'Bench Player', position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, nbaId: null, injuryStatus: null }]
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

it('keeps a fresh lineup on focus and rechecks stale or failed reads', async () => {
    await mount()
    const reads = mocks.readView.mock.calls.length
    for (let cycle = 0; cycle < 3; cycle++) {
        await act(async () => { window.dispatchEvent(new Event('focus')) })
        mocks.hidden = true; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        mocks.hidden = false; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
    mocks.readView.mockRejectedValueOnce(new Error('503'))
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); window.dispatchEvent(new Event('focus')) })
    expect(mocks.readView).toHaveBeenCalledTimes(reads + 1)
    mocks.lineup.benchSlots = 2
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(emptyRows()).toHaveLength(2)
    expect(mocks.readView).toHaveBeenCalledTimes(reads + 2)
})

it('revalidates fresh lineup capacity after league settings change', async () => {
    await mount()
    const reads = mocks.readView.mock.calls.length
    mocks.context.currentLeague = { id: 'league-a', roster_size: 21 }
    mocks.lineup.benchSlots = 4
    await act(async () => { screen.update(React.createElement(Component)) })
    expect(mocks.readView).toHaveBeenCalledTimes(reads + 1)
    expect(emptyRows()).toHaveLength(4)
})

it('catches up missed lineup changes and ignores a disposed owner', async () => {
    await mount()
    const reconnect = () => publishViewChange('league-a', { topic: 'catchup', scopes: null })
    mocks.lineup.benchSlots = 2
    await act(async () => { reconnect(); await vi.advanceTimersByTimeAsync(200) })
    expect(emptyRows()).toHaveLength(2)
    expect(mocks.readView).toHaveBeenLastCalledWith(expect.objectContaining({ screen: 'lineup', leagueId: 'league-a', memberId: 'member-a' }))
    mocks.context.current = { id: 'member-b' }
    mocks.context.currentLeague = { id: 'league-b' }
    await act(async () => { screen.update(React.createElement(Component)) })
    const previousReads = mocks.readView.mock.calls.length
    await act(async () => { reconnect(); await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.readView).toHaveBeenCalledTimes(previousReads)
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


it('removes a player after a compact deletion hint and stops the old league observer', async () => {
    mocks.lineup.bench = [{ playerId: 'player', rosterPlayerId: 'roster-player', displayName: 'Bench Player',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, nbaId: null, injuryStatus: null }]
    await mount()
    expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Bench Bench Player')).toHaveLength(1)
    mocks.lineup = { starters: [], bench: [], benchSlots: 3 }
    await act(async () => { publishViewChange('league-a', { topic: 'lineup', scopes: [{ season_id: 'season-league-a', member_id: 'member-a', date: '2026-10-11' }] }); await vi.advanceTimersByTimeAsync(200) })
    expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Bench Bench Player')).toHaveLength(0)
    expect(mocks.readView).toHaveBeenLastCalledWith(expect.objectContaining({ screen: 'lineup', leagueId: 'league-a', memberId: 'member-a' }))
    mocks.context.current = { id: 'member-b' }
    mocks.context.currentLeague = { id: 'league-b' }
    await act(async () => { screen.update(React.createElement(Component)) })
    const previousReads = mocks.readView.mock.calls.length
    await act(async () => { publishViewChange('league-a', { topic: 'catchup', scopes: null }); await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.readView).toHaveBeenCalledTimes(previousReads)
})


it('does not repeat the read when an equal league context object arrives', async () => {
    await mount()
    mocks.context.currentLeague = { ...mocks.context.currentLeague }
    await act(async () => screen.update(React.createElement(Component)))
    expect(mocks.readView).toHaveBeenCalledOnce()
})

it('retries a failed view through the visible retry control', async () => {
    await mount()
    mocks.readView.mockRejectedValueOnce(new Error('Unavailable'))
    await act(async () => {
        publishViewChange('league-a', { topic: 'lineup', scopes: null })
        await vi.advanceTimersByTimeAsync(200)
    })
    mocks.lineup.benchSlots = 4
    await act(async () => screen.root.findByProps({ accessibilityLabel: 'Retry selected lineup day' }).props.onPress())
    expect(emptyRows()).toHaveLength(4)
    expect(mocks.readView).toHaveBeenCalledTimes(3)
})


it('loads one complete view without waiting for legacy table readiness', async () => {
    Object.assign(window, { WebSocket: function WebSocket() {} })
    await mount()
    expect(mocks.readView).toHaveBeenCalledOnce()
    expect(emptyRows()).toHaveLength(3)
})

it('releases a held initial read on suspension and ignores its late result', async () => {
    let release!: (value: typeof mocks.lineup) => void
    mocks.readView.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    mocks.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    mocks.lineup = { starters: [], bench: [], benchSlots: 6 }
    mocks.hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(emptyRows()).toHaveLength(6)
    await act(async () => { release({ starters: [], bench: [], benchSlots: 2 }) })
    expect(emptyRows()).toHaveLength(6)
    expect(mocks.readView).toHaveBeenCalledTimes(2)
})


it('waits for league identity before deciding that the lineup is empty', async () => {
    mocks.context.current = null as unknown as typeof mocks.context.current
    mocks.context.currentLeague = null as unknown as typeof mocks.context.currentLeague
    await mount()
    expect(JSON.stringify(screen.toJSON())).not.toContain('No active lineup yet.')
    mocks.context.current = { id: 'member-a' }
    mocks.context.currentLeague = { id: 'league-a' }
    await act(async () => screen.update(React.createElement(Component)))
    expect(emptyRows()).toHaveLength(3)
})


it('shows a settled missing league without calling it an empty lineup', async () => {
    mocks.context.current = null as unknown as typeof mocks.context.current
    mocks.context.currentLeague = null as unknown as typeof mocks.context.currentLeague
    mocks.context.membershipValidated = true
    await mount()
    expect(JSON.stringify(screen.toJSON())).toContain('No active league.')
    expect(JSON.stringify(screen.toJSON())).not.toContain('No active lineup yet.')
})

it('keeps a loaded lineup when membership validation alone changes', async () => {
    await mount()
    const reads = mocks.readView.mock.calls.length
    mocks.context.membershipValidated = true
    await act(async () => screen.update(React.createElement(Component)))
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
})

it('shows the first lineup only after the complete server view arrives', async () => {
    let finish!: (value: typeof mocks.lineup) => void
    mocks.readView.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await mount()
    expect(emptyRows()).toHaveLength(0)
    await act(async () => finish(mocks.lineup))
    expect(emptyRows()).toHaveLength(3)
})

it('keeps final-game players locked after their live label ends', async () => {
    const player = { playerId: 'player', rosterPlayerId: 'roster-player', displayName: 'Locked Player', position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'DEN', nbaId: null, injuryStatus: null }
    mocks.lineup.starters = [{ slotType: 'PG', player }]
    mocks.startedTeams = new Set(['DEN'])
    mocks.games = [{ home_team: 'DEN', away_team: 'LAL', status: 'Final' }]
    await mount()
    const row = screen.root.findByProps({ accessibilityLabel: 'PG Locked Player' })
    expect(row.props.disabled).toBe(true)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'LOCK')).toBe(true)
})


it('shows every configured empty starter, IR, and taxi place', async () => {
    mocks.context.currentLeague = { id: 'league-a', ir_slots: 2, taxi_slots: 3 }
    await mount()
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Empty PG slot' })).toHaveLength(1)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Empty ir slot' })).toHaveLength(2)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Empty taxi slot' })).toHaveLength(3)
    expect(emptyRows()).toHaveLength(3)
})

})
