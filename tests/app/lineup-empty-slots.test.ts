import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import LineupScreen from '@/app/(modals)/lineup'
import type { LineupPlayer } from '@/lib/lineup'

const mocks = vi.hoisted(() => ({
    context: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } as { id: string; roster_size?: number }, online: true, membershipValidated: false, membershipError: null as Error | null, refresh: vi.fn() },
    lineup: { starters: [] as { slotType: string; player: null }[], bench: [] as LineupPlayer[], benchSlots: 3 },
    invalidate: vi.fn(),
    readLineup: vi.fn(), readContext: vi.fn(), hidden: false,
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
vi.mock('@/hooks/use-live-stats', () => ({ useLiveStats: () => ({ startedTeams: new Set(), liveTeams: new Set(), teamMatchups: new Map() }) }))
vi.mock('@/lib/lineup', () => ({
    clampDateToWeek: (date: string) => date,
    getLineupContext: mocks.readContext,
    getWeekDays: async () => [{ date: '2026-10-11', playingTeams: [] }, { date: '2026-10-12', playingTeams: [] }],
    invalidateCachedRoster: mocks.invalidate,
    getWeeklyLineup: mocks.readLineup, getLineupMoveTargetState: () => null,
}))
vi.mock('@/lib/lineup/optimizerSettings', () => ({ getLineupOptimizerEnabled: async () => mocks.enabled, setLineupOptimizerEnabled: mocks.setEnabled }))
vi.mock('@/lib/lineup/snapshot', () => ({ readLineupSnapshot: () => null, saveLineupSnapshot: vi.fn(), discardLineupSnapshot: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ readStoredAuthState: () => ({ session: { user: { id: 'user' } } }) }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => 1, onSessionCachesCleared: vi.fn() }))
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

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks(); setLeagueChangesConnected('league-a', false); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
    vi.stubGlobal('window', new EventTarget())
    const page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => mocks.hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page)
    mocks.hidden = false
    mocks.context.current = { id: 'member-a' }; mocks.context.currentLeague = { id: 'league-a' }; mocks.enabled = false
    mocks.context.membershipValidated = false; mocks.context.membershipError = null
    mocks.context.online = true
    mocks.lineup = { starters: [{ slotType: 'PG', player: null }], bench: [], benchSlots: 3 }
    mocks.readContext.mockReset().mockImplementation(async (league: string) => ({ seasonId: `season-${league}`, weekNumber: 1, seasonYear: 2027, today: '2026-10-11' }))
    mocks.readLineup.mockReset().mockImplementation(async () => mocks.lineup)
})
afterEach(async () => { await act(async () => screen?.unmount()); setLeagueChangesConnected('league-a', false); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { screen = create(React.createElement(LineupScreen)) }) }

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
    const reads = mocks.readLineup.mock.calls.length
    for (let cycle = 0; cycle < 3; cycle++) {
        await act(async () => { window.dispatchEvent(new Event('focus')) })
        mocks.hidden = true; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        mocks.hidden = false; await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(mocks.readLineup).toHaveBeenCalledTimes(reads)
    mocks.readLineup.mockRejectedValueOnce(new Error('503'))
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); window.dispatchEvent(new Event('focus')) })
    expect(mocks.readLineup).toHaveBeenCalledTimes(reads + 1)
    mocks.lineup.benchSlots = 2
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(emptyRows()).toHaveLength(2)
    expect(mocks.readLineup).toHaveBeenCalledTimes(reads + 2)
})

it('revalidates fresh lineup capacity after league settings change', async () => {
    await mount()
    const reads = mocks.readLineup.mock.calls.length
    mocks.context.currentLeague = { id: 'league-a', roster_size: 21 }
    mocks.lineup.benchSlots = 4
    await act(async () => { screen.update(React.createElement(LineupScreen)) })
    expect(mocks.readLineup).toHaveBeenCalledTimes(reads + 1)
    expect(emptyRows()).toHaveLength(4)
})

it('catches up missed lineup changes and ignores a disposed owner', async () => {
    await mount()
    const reconnect = () => notifyLeagueChange('league-a', { topic: 'catchup', scopes: null })
    mocks.lineup.benchSlots = 2
    await act(async () => { reconnect(); await vi.advanceTimersByTimeAsync(200) })
    expect(emptyRows()).toHaveLength(2)
    expect(mocks.invalidate).toHaveBeenCalledWith('member-a', 'league-a', 'season-league-a')
    mocks.context.current = { id: 'member-b' }
    mocks.context.currentLeague = { id: 'league-b' }
    await act(async () => { screen.update(React.createElement(LineupScreen)) })
    mocks.invalidate.mockClear()
    await act(async () => { reconnect(); await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.invalidate).not.toHaveBeenCalled()
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
    await act(async () => { notifyLeagueChange('league-a', { topic: 'lineup', scopes: [{ season_id: 'season-league-a', member_id: 'member-a', date: '2026-10-11' }] }); await vi.advanceTimersByTimeAsync(200) })
    expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Bench Bench Player')).toHaveLength(0)
    expect(mocks.invalidate).toHaveBeenCalledWith('member-a', 'league-a', 'season-league-a')
    mocks.context.current = { id: 'member-b' }
    mocks.context.currentLeague = { id: 'league-b' }
    await act(async () => { screen.update(React.createElement(LineupScreen)) })
    mocks.invalidate.mockClear()
    await act(async () => { notifyLeagueChange('league-a', { topic: 'catchup', scopes: null }); await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.invalidate).not.toHaveBeenCalled()
})


it('does not repeat the initial catch-up when a fresh context object arrives', async () => {
    setLeagueChangesConnected('league-a', true)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(mocks.readLineup).toHaveBeenCalledTimes(1)
    expect(mocks.readContext).toHaveBeenCalledTimes(1)
})

it('retries a failed hinted read without waiting for a focus event', async () => {
    await mount()
    mocks.readLineup.mockRejectedValueOnce(new Error('Unavailable'))
    await act(async () => {
        notifyLeagueChange('league-a', { topic: 'lineup', scopes: null })
        await vi.advanceTimersByTimeAsync(200)
    })
    mocks.lineup.benchSlots = 4
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(emptyRows()).toHaveLength(4)
    expect(mocks.readLineup).toHaveBeenCalledTimes(3)
})


it('waits for initial stream readiness before validating the lineup actor', async () => {
    Object.assign(window, { WebSocket: function WebSocket() {} })
    await mount()
    expect(mocks.readContext).not.toHaveBeenCalled()
    await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
        setLeagueChangesConnected('league-a', true)
        notifyLeagueChange('league-a', { topic: 'catchup', scopes: null })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(mocks.readContext).toHaveBeenCalledOnce()
    expect(mocks.readLineup).toHaveBeenCalledOnce()
})

it('uses the bounded fallback when the initial stream never connects', async () => {
    Object.assign(window, { WebSocket: function WebSocket() {} })
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(mocks.readContext).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.readContext).toHaveBeenCalledOnce()
    expect(mocks.readLineup).toHaveBeenCalledOnce()
})

it('queues a fresh authoritative read when a lineup changes during the initial read', async () => {
    setLeagueChangesConnected('league-a', true)
    let release!: (value: typeof mocks.lineup) => void
    mocks.readLineup.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    await act(async () => { notifyLeagueChange('league-a', { topic: 'lineup', scopes: null }) })
    const next = { starters: [], bench: [], benchSlots: 5 }
    mocks.lineup = next
    await act(async () => { release({ starters: [], bench: [], benchSlots: 3 }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(mocks.readContext).toHaveBeenCalledTimes(2)
    expect(mocks.readLineup).toHaveBeenCalledTimes(2)
    expect(emptyRows()).toHaveLength(5)
})

it('releases a held initial read on suspension and ignores its late result', async () => {
    let release!: (value: typeof mocks.lineup) => void
    mocks.readLineup.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    mocks.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    mocks.lineup = { starters: [], bench: [], benchSlots: 6 }
    mocks.hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(emptyRows()).toHaveLength(6)
    await act(async () => { release({ starters: [], bench: [], benchSlots: 2 }) })
    expect(emptyRows()).toHaveLength(6)
    expect(mocks.readLineup).toHaveBeenCalledTimes(2)
})


it('waits for league identity before deciding that the lineup is empty', async () => {
    mocks.context.current = null as unknown as typeof mocks.context.current
    mocks.context.currentLeague = null as unknown as typeof mocks.context.currentLeague
    await mount()
    expect(JSON.stringify(screen.toJSON())).not.toContain('No active lineup yet.')
    mocks.context.current = { id: 'member-a' }
    mocks.context.currentLeague = { id: 'league-a' }
    await act(async () => screen.update(React.createElement(LineupScreen)))
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
    const reads = mocks.readLineup.mock.calls.length
    mocks.context.membershipValidated = true
    await act(async () => screen.update(React.createElement(LineupScreen)))
    expect(mocks.readLineup).toHaveBeenCalledTimes(reads)
})
