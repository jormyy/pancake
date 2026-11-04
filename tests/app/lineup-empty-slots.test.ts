import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLeagueChangesConnected } from '@/lib/league-changes'
import LineupScreen, { LineupEditor } from '@/app/(modals)/lineup'
import type { LineupPlayer } from '@/lib/lineup'
import type { AssetLock } from '@/lib/locked-assets'

const mocks = vi.hoisted(() => ({
    context: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } as { id: string; roster_size?: number; ir_slots?: number; taxi_slots?: number }, online: true, membershipValidated: false, membershipError: null as Error | null, refresh: vi.fn() },
    lineup: { starters: [] as { slotType: string; player: LineupPlayer | null }[], bench: [] as LineupPlayer[], benchSlots: 3 },
    setPin: vi.fn(), optimizeDate: vi.fn(), snapshot: false,
    readView: vi.fn(), hidden: false, dirty: false, listeners: new Map<() => void, string>(),
    freshness: 'fresh', games: [] as { home_team: string; away_team: string; status: string }[], startedTeams: new Set<string>(),
    teamMatchups: {} as Record<string, Record<string, { opponent: string; isHome: boolean }>>,
    enabled: false, setEnabled: vi.fn(), showAlert: vi.fn(), handleTap: vi.fn(), setSelected: vi.fn(),
    selection: null as { kind: 'starter' | 'bench'; index: number } | null, params: {} as { playerId?: string },
}))
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View', Text: 'Text', ScrollView: 'ScrollView', Switch: 'Switch', StyleSheet: { create: (v: unknown) => v, flatten: (v: unknown) => Object.assign({}, ...[v].flat(Infinity).filter(Boolean)) } }))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => mocks.context }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-lineup-actions', () => ({ useLineupActions: () => ({
    selected: mocks.selection, setSelected: mocks.setSelected, saving: false, autoSetModalVisible: true,
    setAutoSetModalVisible: vi.fn(), handleTap: mocks.handleTap, handleAutoSet: vi.fn(),
}) }))
vi.mock('@/lib/cache/screen-cache', () => ({
    cachedScreenView: () => ({ dirty: mocks.dirty }),
    subscribeScreenView: (scope: { leagueId: string }, listener: () => void) => { mocks.listeners.set(listener, scope.leagueId); return () => { mocks.listeners.delete(listener) } },
    readScreenView: async (scope: { leagueId: string; params: { date: string } }) => {
        const lineup = await mocks.readView(scope)
        mocks.dirty = false
        return { context: { seasonId: `season-${scope.leagueId}`, weekNumber: 1, seasonYear: 2027, today: '2026-10-11' },
            date: scope.params.date, weekDays: [{ date: '2026-10-11', playingTeams: [] }, { date: '2026-10-12', playingTeams: [] }],
            ir: [], taxi: [], ...lineup, optimizer: { enabled: mocks.enabled }, games: mocks.games, startedTeams: [...mocks.startedTeams], teamMatchups: mocks.teamMatchups[scope.params.date] ?? {},
        }
    },
}))
vi.mock('@/lib/lineup', () => ({ getLineupMoveTargetState: () => null }))
vi.mock('@/lib/lineup/pins', () => ({ setLineupPlayerPin: mocks.setPin, optimizeLineupDate: mocks.optimizeDate }))
vi.mock('@/lib/lineup/optimizerSettings', () => ({ getLineupOptimizerEnabled: async () => mocks.enabled, setLineupOptimizerEnabled: mocks.setEnabled }))
vi.mock('@/lib/lineup/snapshot', () => ({ readLineupSnapshot: (_scope: unknown, date: string) => mocks.snapshot ? {
    context: { seasonId: 'season-league-a', weekNumber: 1, seasonYear: 2027, today: '2026-10-11' },
    date, days: [{ date, playingTeams: [] }], ...mocks.lineup, ir: [], taxi: [], optimizerEnabled: false,
} : null, saveLineupSnapshot: vi.fn(), discardLineupSnapshot: vi.fn(), updateLineupOptimizerSnapshot: vi.fn() }))
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
    mocks.snapshot = false; mocks.setPin.mockReset().mockResolvedValue({}); mocks.optimizeDate.mockReset().mockResolvedValue(undefined)
    mocks.teamMatchups = {}
    mocks.freshness = 'fresh'; mocks.games = []; mocks.startedTeams = new Set()
    mocks.hidden = false; mocks.dirty = false; mocks.listeners.clear()
    mocks.context.current = { id: 'member-a' }; mocks.context.currentLeague = { id: 'league-a' }; mocks.enabled = false
    mocks.context.membershipValidated = false; mocks.context.membershipError = null
    mocks.context.online = true
    mocks.selection = null; mocks.params = {}
    mocks.lineup = { starters: [{ slotType: 'PG', player: null }], bench: [], benchSlots: 3 }
    mocks.readView.mockReset().mockImplementation(async () => mocks.lineup)
})
afterEach(async () => { await act(async () => screen?.unmount()); setLeagueChangesConnected('league-a', false); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { screen = create(React.createElement(Component)) }) }

const emptyRows = () => screen.root.findAllByType('Text' as React.ElementType)
    .filter((node) => node.props.children === 'Empty bench slot')

const pinPlayer = (id: string, pin: LineupPlayer['lineupPin'] = null): LineupPlayer => ({
    playerId: id, rosterPlayerId: id, displayName: id, position: 'PG', eligiblePositions: ['PG'],
    nbaTeam: 'LAL', nbaId: null, injuryStatus: null, lineupPin: pin,
})
const pinButton = (label: string) => screen.root.findByProps({ accessibilityLabel: label })
const tapPin = (label: string) => act(async () => pinButton(label).props.onPress({ stopPropagation: vi.fn() }))

it('shows Start, Auto and Bench for occupied active rows only', async () => {
    mocks.lineup = { starters: [{ slotType: 'PG', player: pinPlayer('Starter', 'start') }, { slotType: 'SG', player: null }],
        bench: [pinPlayer('Bench', 'bench')], benchSlots: 3 }
    mocks.readView.mockResolvedValue({ ...mocks.lineup, ir: [pinPlayer('IR')], taxi: [pinPlayer('Taxi')] })
    await mount()
    expect(screen.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(6)
    expect(pinButton('Pin Starter to start').props.accessibilityState.checked).toBe(true)
    expect(pinButton('Set Starter to Auto').props.accessibilityState.checked).toBe(false)
    expect(pinButton('Pin Bench to bench').props.accessibilityState.checked).toBe(true)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Lineup pin for IR' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Lineup pin for Taxi' })).toHaveLength(0)
})

it('keeps Auto selected when older saved data has no pin field', async () => {
    const player = pinPlayer('Player')
    delete player.lineupPin
    mocks.lineup.bench = [player]
    await mount()
    expect(pinButton('Set Player to Auto').props.accessibilityState.checked).toBe(true)
})

it.each(['starter', 'bench'] as const)('disables pins on locked %s rows', async kind => {
    const player = pinPlayer('Locked')
    if (kind === 'starter') mocks.lineup.starters = [{ slotType: 'PG', player }]
    else mocks.lineup.bench = [player]
    mocks.startedTeams = new Set(['LAL'])
    await mount()
    expect(pinButton('Pin Locked to start').props.disabled).toBe(true)
    await tapPin('Pin Locked to start')
    expect(mocks.setPin).not.toHaveBeenCalled()
})

it.each(['past', 'offline', 'read-only'] as const)('disables pins when %s', async mode => {
    mocks.lineup.bench = [pinPlayer('Player')]
    if (mode === 'offline') { mocks.snapshot = true; mocks.context.online = false }
    await mount()
    if (mode === 'past') await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-10'))
    if (mode === 'read-only') {
        mocks.readView.mockRejectedValueOnce(new Error('Unavailable'))
        await act(async () => publishViewChange('league-a', {}))
    }
    expect(pinButton('Pin Player to start').props.disabled).toBe(true)
    await tapPin('Pin Player to start')
    expect(mocks.setPin).not.toHaveBeenCalled()
})

it('saves the selected date pin, optimizes it, then reloads without selecting the row', async () => {
    mocks.lineup.bench = [pinPlayer('Player')]
    await mount()
    await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    const reads = mocks.readView.mock.calls.length
    let finishPin!: () => void
    let finishOptimize!: () => void
    mocks.setPin.mockImplementationOnce(() => new Promise<void>(resolve => { finishPin = resolve }))
    mocks.optimizeDate.mockImplementationOnce(() => new Promise<void>(resolve => { finishOptimize = resolve }))
    const stopPropagation = vi.fn()
    await act(async () => pinButton('Pin Player to start').props.onPress({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(mocks.setPin).toHaveBeenCalledExactlyOnceWith('league-a', 'Player', '2026-10-12', 'start')
    expect(mocks.optimizeDate).not.toHaveBeenCalled()
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
    expect(pinButton('Pin Player to bench').props.disabled).toBe(true)
    await act(async () => finishPin())
    expect(mocks.optimizeDate).toHaveBeenCalledExactlyOnceWith('member-a', 'league-a', 'season-league-a', '2026-10-12')
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
    mocks.lineup.bench = [pinPlayer('Player', 'start')]
    await act(async () => finishOptimize())
    expect(mocks.readView).toHaveBeenCalledTimes(reads + 1)
    expect(pinButton('Pin Player to start').props.accessibilityState.checked).toBe(true)
    expect(mocks.handleTap).not.toHaveBeenCalled()
    await act(async () => screen.root.findByProps({ accessibilityLabel: 'Bench Player' }).props.onPress())
    expect(mocks.handleTap).toHaveBeenCalledExactlyOnceWith({ kind: 'bench', index: 0 })
})

it('preserves the prior pin and reports a failed pin save', async () => {
    mocks.lineup.bench = [pinPlayer('Player', 'bench')]
    await mount()
    const reads = mocks.readView.mock.calls.length
    mocks.setPin.mockRejectedValueOnce(new Error('Rejected'))
    await tapPin('Pin Player to start')
    expect(pinButton('Pin Player to bench').props.accessibilityState.checked).toBe(true)
    expect(pinButton('Pin Player to start').props.disabled).toBe(false)
    expect(mocks.showAlert).toHaveBeenCalledWith('Error', 'Rejected')
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
    expect(mocks.optimizeDate).not.toHaveBeenCalled()
})

it.each(['start', null] as const)('reloads the saved pin after optimization fails: %s', async pin => {
    mocks.lineup.bench = [pinPlayer('Player', 'bench')]
    await mount()
    await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    const reads = mocks.readView.mock.calls.length
    mocks.setPin.mockImplementationOnce(async () => { mocks.lineup.bench = [pinPlayer('Player', pin)] })
    mocks.optimizeDate.mockRejectedValueOnce(new Error('Optimization failed'))
    await tapPin(pin === 'start' ? 'Pin Player to start' : 'Set Player to Auto')
    expect(mocks.showAlert).toHaveBeenCalledWith('Error', 'Optimization failed')
    expect(mocks.readView).toHaveBeenCalledTimes(reads + 1)
    expect(mocks.readView).toHaveBeenLastCalledWith(expect.objectContaining({ params: { date: '2026-10-12' } }))
    expect(mocks.showAlert.mock.invocationCallOrder[0]).toBeLessThan(mocks.readView.mock.invocationCallOrder.at(-1)!)
    expect(pinButton(pin === 'start' ? 'Pin Player to start' : 'Set Player to Auto').props.accessibilityState.checked).toBe(true)
    expect(pinButton('Pin Player to bench').props.disabled).toBe(false)
})

it.each(['date', 'owner'] as const)('does not reload an old pin date after the %s changes', async change => {
    mocks.lineup.bench = [pinPlayer('Player', 'bench')]
    await mount()
    let failOptimize!: (error: Error) => void
    mocks.optimizeDate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failOptimize = reject }))
    await tapPin('Pin Player to start')
    if (change === 'date') await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    else {
        mocks.context.current = { id: 'member-b' }
        await act(async () => screen.update(React.createElement(Component)))
    }
    const reads = mocks.readView.mock.calls.length
    await act(async () => failOptimize(new Error('Optimization failed')))
    expect(mocks.readView).toHaveBeenCalledTimes(reads)
    if (change === 'owner') expect(mocks.showAlert).not.toHaveBeenCalled()
    else expect(screen.root.findByType('DaySelector' as React.ElementType).props.selectedDate).toBe('2026-10-12')
})

it('clears a pin through Auto and ignores an already selected segment', async () => {
    mocks.lineup.bench = [pinPlayer('Player', 'bench')]
    await mount()
    await tapPin('Pin Player to bench')
    expect(mocks.setPin).not.toHaveBeenCalled()
    await tapPin('Set Player to Auto')
    expect(mocks.setPin).toHaveBeenCalledWith('league-a', 'Player', '2026-10-11', null)
})

it('shows Pinned, no slot only on an unlocked Start-pinned bench player', async () => {
    mocks.teamMatchups['2026-10-11'] = { LAL: { opponent: 'BOS', isHome: true } }
    mocks.lineup.starters = [{ slotType: 'PG', player: pinPlayer('Starter', 'start') }]
    mocks.lineup.bench = [pinPlayer('Pinned', 'start'), pinPlayer('Auto'), pinPlayer('Benched', 'bench')]
    await mount()
    const notes = () => screen.root.findAllByType('Text' as React.ElementType).filter(node => node.props.children === 'Pinned, no slot')
    expect(notes()).toHaveLength(1)
    mocks.startedTeams = new Set(['LAL'])
    await act(async () => publishViewChange('league-a', {}))
    expect(notes()).toHaveLength(0)
})

it.each([
    ['Out', true, 'Pinned, but Out'],
    ['OUT', false, 'Pinned, but Out'],
    ['IR', true, 'Pinned, but Out'],
    ['ir-lt', false, 'Pinned, but Out'],
    ['Ir+', true, 'Pinned, but Out'],
    [null, false, 'Pinned, no game'],
    ['Questionable', false, 'Pinned, no game'],
    ['Doubtful', true, 'Pinned, no slot'],
    ['Questionable', true, 'Pinned, no slot'],
    [null, true, 'Pinned, no slot'],
] as const)('explains a benched Start pin with injury %s and game %s', async (injuryStatus, hasGame, note) => {
    mocks.lineup.bench = [{ ...pinPlayer('Player', 'start'), injuryStatus }]
    if (hasGame) mocks.teamMatchups['2026-10-11'] = { LAL: { opponent: 'BOS', isHome: true } }
    await mount()
    const notes = () => screen.root.findAllByType('Text' as React.ElementType)
        .map(node => node.props.children).filter(text => typeof text === 'string' && text.startsWith('Pinned,'))
    expect(notes()).toEqual([note])
    mocks.startedTeams = new Set(['LAL'])
    await act(async () => publishViewChange('league-a', {}))
    expect(notes()).toEqual([])
})

it('uses the selected day to explain a pin when the game schedule changes', async () => {
    mocks.lineup.bench = [pinPlayer('Player', 'start')]
    mocks.teamMatchups['2026-10-11'] = { LAL: { opponent: 'BOS', isHome: true } }
    await mount()
    const notes = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(notes()).toContain('Pinned, no slot')
    await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    expect(notes()).toContain('Pinned, no game')
    expect(notes()).not.toContain('Pinned, no slot')
})

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

it.each(['trade', 'claim'] as const)('allows starter and bench placement with a pending %s reservation', async (sourceKind) => {
    const reserved: LineupPlayer & { assetLocks: AssetLock[] } = { playerId: 'reserved', rosterPlayerId: 'reserved-roster', displayName: 'Reserved Player',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'LAL', nbaId: null, injuryStatus: null,
        assetLocks: [{ assetKind: 'player', assetId: 'reserved', sourceKind, sourceId: 'reservation', reason: `Locked by ${sourceKind}` }] }
    mocks.lineup.starters = [{ slotType: 'PG', player: reserved }]
    mocks.lineup.bench = [{ ...reserved, playerId: 'bench', displayName: 'Reserved Bench' }]
    await mount()
    for (const [label, selection] of [['PG Reserved Player', { kind: 'starter', index: 0 }], ['Bench Reserved Bench', { kind: 'bench', index: 0 }]] as const) {
        const row = screen.root.findByProps({ accessibilityLabel: label })
        expect(row.props.disabled).toBe(false)
        expect(row.props.accessibilityState.disabled).toBe(false)
        await act(async () => row.props.onPress())
        expect(mocks.handleTap).toHaveBeenLastCalledWith(selection)
        mocks.selection = selection
        await act(async () => screen.update(React.createElement(Component)))
        expect(screen.root.findByProps({ accessibilityLabel: label }).props.accessibilityState.selected).toBe(true)
        expect(mocks.setSelected).not.toHaveBeenCalledWith(null)
    }
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Asset locked' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ accessibilityLabel: `Locked by a pending ${sourceKind === 'trade' ? 'trade' : 'waiver claim'}` })).toHaveLength(2)
    const toggle = screen.root.findByType('Switch' as React.ElementType)
    expect(toggle.props.disabled).toBe(false)
    await act(async () => toggle.props.onValueChange(true))
    expect(mocks.setEnabled).toHaveBeenCalledWith('member-a', 'league-a', 'season-league-a', true)
})

it.each(['trade', 'claim'] as const)('preselects a reserved %s player opened from the roster', async (sourceKind) => {
    const player = { playerId: 'reserved', rosterPlayerId: 'reserved-roster', displayName: 'Reserved Player',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, nbaId: null, injuryStatus: null,
        assetLocks: [{ assetKind: 'player', assetId: 'reserved', sourceKind, sourceId: 'reservation', reason: 'Locked by reservation' }] }
    mocks.lineup.bench = [player]
    mocks.params = { playerId: 'reserved' }
    await mount()
    expect(mocks.setSelected).toHaveBeenCalledWith({ kind: 'bench', index: 0 })
})

it('shows reservation icons on read-only IR and Taxi rows', async () => {
    const player = { playerId: 'reserve', rosterPlayerId: 'reserve-roster', displayName: 'Reserve Player',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, nbaId: null, injuryStatus: null,
        assetLocks: [{ assetKind: 'player', assetId: 'reserve', sourceKind: 'trade', sourceId: 'trade', reason: 'Locked by trade' }] }
    mocks.readView.mockImplementationOnce(async () => ({ ...mocks.lineup, ir: [player], taxi: [player] }))
    await mount()
    expect(screen.root.findAllByProps({ accessibilityLabel: 'IR Reserve Player' })).toHaveLength(1)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Taxi Reserve Player' })).toHaveLength(1)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Asset locked' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Locked by a pending trade' })).toHaveLength(2)
})

it.each(['starter', 'bench'])('keeps game-time locks on a reserved %s', async (kind) => {
    const player: LineupPlayer & { assetLocks: AssetLock[] } = { playerId: 'reserved', rosterPlayerId: 'reserved-roster', displayName: 'Started Player',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'LAL', nbaId: null, injuryStatus: null,
        assetLocks: [{ assetKind: 'player', assetId: 'reserved', sourceKind: 'trade', sourceId: 'trade', reason: 'Locked by trade' }] }
    if (kind === 'starter') mocks.lineup.starters = [{ slotType: 'PG', player }]
    else mocks.lineup.bench = [player]
    mocks.startedTeams = new Set(['LAL'])
    await mount()
    const row = screen.root.findByProps({ accessibilityLabel: `${kind === 'starter' ? 'PG' : 'Bench'} Started Player` })
    expect(row.props.disabled).toBe(true)
    expect(row.props.accessibilityState.disabled).toBe(true)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'LOCK')).toBe(true)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Asset locked' })).toHaveLength(0)
})

it('uses the new day capacity after switching dates', async () => {
    await mount()
    mocks.lineup = { starters: [], bench: [], benchSlots: 2 }
    await act(async () => screen.root.findByType('DaySelector' as React.ElementType).props.onSelect('2026-10-12'))
    expect(emptyRows()).toHaveLength(2)
    expect(mocks.readView).toHaveBeenLastCalledWith(expect.objectContaining({ params: { date: '2026-10-12' } }))
    expect(screen.root.findByType('DaySelector' as React.ElementType).props.selectedDate).toBe('2026-10-12')
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

vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: undefined }) }))
