import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LineupPlayer } from '@/lib/lineup'
import { saveHomeGameDisplay } from '@/lib/home-surface'
import { clearSessionCaches } from '@/lib/session-cache-registry'
import HomeScreen from '@/app/(tabs)/index'

const mocks = vi.hoisted(() => ({
    lineup: { starters: [{ slotType: 'PG', player: null as LineupPlayer | null }], bench: [] as LineupPlayer[], benchSlots: 3, ir: [], taxi: [] },
    league: { id: 'league', roster_size: 20, ir_slots: 2, taxi_slots: 2 },
    setSelected: vi.fn(), doAutoSet: vi.fn(), setSelectedDate: vi.fn(), loadLineups: vi.fn(),
    selectedDate: '2026-10-11', lineupError: false,
    freshness: 'fresh',
    games: [] as { home_team: string; away_team: string; status: string }[],
}))
vi.mock('@/components/WeekOffNotice', () => ({ WeekOffNotice: 'WeekOffNotice' }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    memberships: [{ id: 'member' }], current: { id: 'member' }, currentLeague: mocks.league,
}) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' }, loading: false }) }))
vi.mock('@/hooks/use-matchup-data', () => ({ useMatchupData: () => ({
    matchup: { myMemberId: 'member', seasonId: 'season', seasonYear: 2027, weekNumber: 1 },
    leagueMatchups: [], weekDays: [{ date: '2026-10-11' }, { date: '2026-10-12' }], selectedDate: mocks.selectedDate,
    myLineup: mocks.lineupError ? null : mocks.lineup, oppLineup: mocks.lineupError ? null : mocks.lineup, lineupError: mocks.lineupError,
    setSelectedDate: mocks.setSelectedDate, loadLineups: mocks.loadLineups, matchupRef: { current: { id: 'matchup' } },
}) }))
vi.mock('@/hooks/use-live-stats', () => ({ useLiveStats: () => ({ todaysGames: mocks.games, freshness: mocks.freshness, liveStats: new Map(), startedTeams: new Set(), liveTeams: new Set(), teamMatchups: new Map() }) }))
vi.mock('@/hooks/use-lineup-actions', () => ({ useLineupActions: () => ({ setSelected: mocks.setSelected, doAutoSet: mocks.doAutoSet }) }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/lineup', () => ({ getLineupMoveTargetState: () => null }))
vi.mock('@/lib/score-breakdown', () => ({ lineupStatColumns: () => [] }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-11' }))
vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String }))
vi.mock('@/components/ui', () => ({ Page: 'Page', ErrorBanner: 'ErrorBanner', usePageMetrics: () => ({ padX: 16, usableWidth: 358 }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/Scoreboard', () => ({ Scoreboard: 'Scoreboard' }))
vi.mock('@/components/ScoreCard', () => ({ ScoreCard: 'ScoreCard' }))
vi.mock('@/components/DaySelector', () => ({ DaySelector: 'DaySelector' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/ActivationOverflowModal', () => ({ ActivationOverflowModal: 'ActivationOverflowModal' }))
vi.mock('@/components/ScoreBreakdownSheet', () => ({ ScoreBreakdownSheet: 'ScoreBreakdownSheet' }))
vi.mock('@/components/LeagueSwitcher', () => ({ LeagueSwitcher: 'LeagueSwitcher' }))
vi.mock('@/components/MatchupRow', () => ({ MatchupColumnHeader: 'MatchupColumnHeader', MatchupRow: 'MatchupRow', statLineupWidth: () => 800 }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable', MotionView: 'MotionView' }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectedDate = '2026-10-11'
    mocks.lineupError = false
    clearSessionCaches()
    mocks.freshness = 'fresh'
    mocks.games = []
    mocks.lineup = { ...mocks.lineup, starters: [{ slotType: 'PG', player: null }] }
    mocks.lineup.benchSlots = 3
    mocks.lineup.bench = []
    mocks.league.ir_slots = 2
    mocks.league.taxi_slots = 2
})
afterEach(async () => { await act(async () => screen?.unmount()) })
const mount = async () => { await act(async () => { screen = create(React.createElement(HomeScreen)) }) }
const rows = (slot: string) => screen.root.findAllByType('MatchupRow' as React.ElementType).filter((node) => node.props.slotType === slot)

const populatedStarters = () => {
    mocks.lineup.starters = [{ slotType: 'PG', player: {
        rosterPlayerId: 'roster', playerId: 'player', displayName: 'Player', position: 'PG',
        eligiblePositions: ['PG'], nbaTeam: 'LAL', injuryStatus: null, nbaId: null,
    } }]
}

it('shows the BE template count instead of deriving bench places from roster size', async () => {
    await mount()
    expect(rows('PG')).toHaveLength(0)
    expect(screen.root.findByProps({ accessibilityLabel: 'No lineups set this day' }).props.children).toBe('No lineups set this day')
    expect(rows('BE')).toHaveLength(3)
    expect(rows('IR')).toHaveLength(2)
    expect(rows('TX')).toHaveLength(2)
})

it('omits reserve sections with zero configured places', async () => {
    mocks.lineup.starters = []
    mocks.lineup.benchSlots = 0
    mocks.league.ir_slots = 0
    mocks.league.taxi_slots = 0
    await mount()
    expect(rows('PG')).toHaveLength(0)
    expect(screen.root.findAllByType('Text' as React.ElementType).filter((node) => node.props.children === 'Starters')).toHaveLength(0)
    expect(rows('BE')).toHaveLength(0)
    expect(rows('IR')).toHaveLength(0)
    expect(rows('TX')).toHaveLength(0)
})

it('hides the bench fraction without a lineup and never shows an over-capacity fraction', async () => {
    populatedStarters()
    const player = mocks.lineup.starters[0].player!
    mocks.lineup.bench = [player]
    await mount()
    const counts = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(counts()).toContain('1/3')
    mocks.lineup = { ...mocks.lineup, starters: [{ slotType: 'PG', player: null }] }
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(counts()).not.toContain('1/3')
    populatedStarters()
    mocks.lineup = { ...mocks.lineup, bench: Array(4).fill(player) }
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(counts()).not.toContain('4/3')
    expect(rows('BE')).toHaveLength(4)
})

it('shows the first matchup with complete game data and retains it through revalidation', async () => {
    populatedStarters()
    mocks.freshness = 'refreshing'
    await mount()
    expect(rows('PG')).toHaveLength(0)
    mocks.freshness = 'fresh'
    mocks.games = [{ home_team: 'DEN', away_team: 'LAL', status: 'InProgress' }]
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(rows('PG')).toHaveLength(1)
    mocks.freshness = 'refreshing'
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(rows('PG')).toHaveLength(1)
    expect(rows('PG')[0].props.liveTeams).toEqual(new Set(['DEN', 'LAL']))
})

it('shows a recent complete game display during the initial live refresh', async () => {
    populatedStarters()
    mocks.freshness = 'refreshing'
    saveHomeGameDisplay(JSON.stringify(['user', 'league', 'member', 'season', undefined]), '2026-10-11', '["player"]', {
        todaysGames: [{ id: 'game', nba_game_id: '0022700001', game_date: '2026-10-11', home_team: 'DEN', away_team: 'LAL', home_score: 10, away_score: 9, status: 'InProgress', game_status_text: 'Q1' }],
        liveStats: new Map(), startedTeams: new Set(['DEN', 'LAL']), teamMatchups: new Map([['DEN', { opponent: 'LAL', isHome: true }]]),
    })
    await mount()
    expect(rows('PG')).toHaveLength(1)
    expect(rows('PG')[0].props.liveTeams).toEqual(new Set(['DEN', 'LAL']))
    mocks.freshness = 'fresh'
    mocks.games = [{ home_team: 'DEN', away_team: 'LAL', status: 'Final' }]
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(rows('PG')).toHaveLength(1)
    expect(rows('PG')[0].props.liveTeams.size).toBe(0)
})

it('auto-sets today when the manager views another date', async () => {
    mocks.selectedDate = '2026-10-12'
    await mount()
    screen.root.findByType('AutoSetModal' as React.ElementType).props.onToday()
    expect(mocks.doAutoSet).toHaveBeenCalledWith('2026-10-11')
})

it('replaces old rows with one error and leaves the day selector active', async () => {
    populatedStarters()
    await mount()
    expect(rows('PG')).toHaveLength(1)
    mocks.lineupError = true
    mocks.selectedDate = '2026-10-12'
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(rows('PG')).toHaveLength(0)
    expect(screen.root.findAllByType('ErrorBanner' as React.ElementType)).toHaveLength(1)
    const selector = screen.root.findByType('DaySelector' as React.ElementType)
    expect(selector.props.selectedDate).toBe('2026-10-12')
    const boundary = screen.root.findAllByType('View' as React.ElementType).find(node => 'inert' in node.props)
    expect(boundary?.props.inert).toBe(false)
    await act(async () => { await selector.props.onSelect('2026-10-11') })
    expect(mocks.setSelectedDate).toHaveBeenCalledWith('2026-10-11')
    expect(mocks.loadLineups).toHaveBeenCalledWith({ id: 'matchup' }, '2026-10-11')
})
