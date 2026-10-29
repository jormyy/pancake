import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LineupPlayer } from '@/lib/lineup'
import { saveHomeGameDisplay } from '@/lib/home-surface'
import { clearSessionCaches } from '@/lib/session-cache-registry'
import HomeScreen from '@/app/(tabs)/index'
import { OtherMatchups } from '@/components/OtherMatchups'
import type { LeagueWeekMatchup } from '@/lib/scoring'
vi.mock('@/components/home/InlineLineupEditor', () => ({ InlineLineupEditor: 'InlineLineupEditor' }))
vi.mock('@/components/home/DailyWaivers', () => ({ DailyWaivers: 'DailyWaivers' }))

vi.mock('@/hooks/use-matchup-forecast', () => ({ useMatchupForecast: () => ({ forecast: null, loading: false }) }))
vi.mock('@/components/MatchupForecastSummary', () => ({ MatchupForecastSummary: 'MatchupForecastSummary' }))

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    leagueMatchups: [] as LeagueWeekMatchup[],
    lineup: { starters: [{ slotType: 'PG', player: null as LineupPlayer | null }], bench: [] as LineupPlayer[], benchSlots: 3, ir: [], taxi: [] },
    league: { id: 'league', roster_size: 20, ir_slots: 2, taxi_slots: 2 },
    refreshHome: vi.fn(async () => {}), refreshAnnouncements: vi.fn(async () => {}),
    setSelected: vi.fn(), setSelectedDate: vi.fn(), loadLineups: vi.fn(),
    selectedDate: '2026-10-11', lineupError: false,
    freshness: 'fresh',
    announcementsLoaded: true, announcementRead: vi.fn(),
    announcements: [] as { id: string; body: string; league_id: string; published_at: string; author_member_id: string | null }[],
    games: [] as { home_team: string; away_team: string; status: string }[],
}))
vi.mock('@/components/WeekOffNotice', () => ({ WeekOffNotice: 'WeekOffNotice' }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl',
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    memberships: [{ id: 'member' }], current: { id: 'member' }, currentLeague: mocks.league, membershipValidated: false,
}) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' }, loading: false }) }))
vi.mock('@/hooks/use-league-announcements', () => ({ useLeagueAnnouncements: (...args: unknown[]) => { mocks.announcementRead(...args); return { announcements: mocks.announcements, loaded: mocks.announcementsLoaded, refreshing: false, refresh: mocks.refreshAnnouncements } } }))
vi.mock('@/hooks/use-matchup-data', () => ({ useMatchupData: () => ({
    refresh: mocks.refreshHome,
    announcements: { announcements: mocks.announcements, loaded: mocks.announcementsLoaded, refreshing: false, refresh: mocks.refreshAnnouncements },
    forecastState: { forecast: null, pending: false, error: false, stale: false },
    liveSnapshot: { todaysGames: mocks.games, freshness: mocks.freshness, liveStats: new Map(), startedTeams: new Set(), liveTeams: new Set(), teamMatchups: new Map() },
    matchup: { myMemberId: 'member', seasonId: 'season', seasonYear: 2027, weekNumber: 1 },
    leagueMatchups: mocks.leagueMatchups, weekDays: [{ date: '2026-10-11' }, { date: '2026-10-12' }], selectedDate: mocks.selectedDate,
    myLineup: mocks.lineupError ? null : mocks.lineup, oppLineup: mocks.lineupError ? null : mocks.lineup, lineupError: mocks.lineupError,
    setSelectedDate: mocks.setSelectedDate, loadLineups: mocks.loadLineups, matchupRef: { current: { id: 'matchup' } },
}) }))
vi.mock('@/hooks/use-live-stats', () => ({ useLiveStats: () => ({ todaysGames: mocks.games, freshness: mocks.freshness, liveStats: new Map(), startedTeams: new Set(), liveTeams: new Set(), teamMatchups: new Map() }) }))
vi.mock('@/hooks/use-lineup-actions', () => ({ useLineupActions: () => ({ setSelected: mocks.setSelected, setAutoSetModalVisible: vi.fn() }) }))
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
    mocks.leagueMatchups = []
    mocks.announcementsLoaded = true
    mocks.announcements = []
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
const mount = async (details = true) => {
    await act(async () => { screen = create(React.createElement(HomeScreen)) })
    if (details && screen.root.findAllByProps({ accessibilityLabel: 'Toggle matchup details' }).length) await act(async () => screen.root.findByProps({ accessibilityLabel: 'Toggle matchup details' }).props.onPress())
}
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

it('opens the manual editor from the auto-set sheet', async () => {
    await mount()
    const sheet = screen.root.findByType('AutoSetModal' as React.ElementType)
    expect(sheet.props.onToday).toBeUndefined()
    expect(sheet.props.onWholeWeek).toBeUndefined()
    expect(sheet.props.onRestOfSeason).toBeUndefined()
    await act(async () => sheet.props.onEditManually())
    expect(mocks.push).toHaveBeenCalledWith('/lineup')
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

it('keeps a warm matchup visible and omits announcements when their read finishes', async () => {
    mocks.announcementsLoaded = false
    await mount()
    expect(screen.root.findAllByType('ScoreCard' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByProps({ testID: 'home-announcement' })).toHaveLength(0)
    mocks.announcements = [{ id: 'newest', body: 'Set your lineup today.', league_id: 'league', published_at: new Date().toISOString(), author_member_id: 'commissioner' }]
    mocks.announcementsLoaded = true
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(screen.root.findAllByType('ScoreCard' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByProps({ testID: 'home-announcement' })).toHaveLength(0)
})

it('pulls fresh Home data without remounting the loaded matchup', async () => {
    await mount()
    const card = screen.root.findByType('ScoreCard' as React.ElementType)
    const pull = screen.root.findAllByType('ScrollView' as React.ElementType).find(node => node.props.refreshControl)?.props.refreshControl
    expect(pull).toBeDefined()
    await act(async () => { await pull.props.onRefresh() })
    expect(mocks.refreshHome).toHaveBeenCalledOnce()
    expect(mocks.refreshAnnouncements).not.toHaveBeenCalled()
    expect(screen.root.findByType('ScoreCard' as React.ElementType)).toBe(card)
})

it('refreshes Home from the web pull gesture', async () => {
    await mount()
    const scroll = screen.root.findAllByType('ScrollView' as React.ElementType).find(node => node.props.refreshControl)!
    expect(scroll.props.onTouchStart).toEqual(expect.any(Function))
    await act(async () => {
        scroll.props.onTouchStart({ nativeEvent: { touches: [{ pageX: 100, pageY: 100 }] } })
        scroll.props.onTouchMove({ nativeEvent: { touches: [{ pageX: 100, pageY: 200 }] } })
        scroll.props.onTouchEnd()
    })
    expect(mocks.refreshHome).toHaveBeenCalledOnce()
    expect(mocks.refreshAnnouncements).not.toHaveBeenCalled()
})

it('renders the cached score card offline without an announcement read', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    mocks.announcementsLoaded = false
    try {
        await mount()
        expect(screen.root.findAllByType('ScoreCard' as React.ElementType)).toHaveLength(1)
    } finally { vi.unstubAllGlobals() }
})

it('keeps the first Home layout when a later announcement read returns a banner', async () => {
    await mount()
    const card = screen.root.findByType('ScoreCard' as React.ElementType)
    mocks.announcements = [{ id: 'late', body: 'Arrived later.', league_id: 'league', published_at: new Date().toISOString(), author_member_id: 'commissioner' }]
    await act(async () => screen.update(React.createElement(HomeScreen)))
    expect(screen.root.findByType('ScoreCard' as React.ElementType)).toBe(card)
    expect(screen.root.findAllByProps({ testID: 'home-announcement' })).toHaveLength(0)
})

it('keeps announcements off Home after pull refresh without remounting the matchup', async () => {
    await mount()
    const card = screen.root.findByType('ScoreCard' as React.ElementType)
    mocks.refreshAnnouncements.mockImplementationOnce(async () => {
        mocks.announcements = [{ id: 'pull', body: 'Returned by pull refresh.', league_id: 'league', published_at: new Date().toISOString(), author_member_id: 'commissioner' }]
    })
    const pull = screen.root.findAllByType('ScrollView' as React.ElementType).find(node => node.props.refreshControl)!.props.refreshControl
    await act(async () => pull.props.onRefresh())
    expect(screen.root.findAllByProps({ testID: 'home-announcement' })).toHaveLength(0)
    expect(screen.root.findByType('ScoreCard' as React.ElementType)).toBe(card)
})

it('keeps announcements off Home when it returns to the foreground', async () => {
    const page = new EventTarget()
    let hidden = false
    Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page)
    try {
        await mount()
        const card = screen.root.findByType('ScoreCard' as React.ElementType)
        mocks.refreshAnnouncements.mockImplementationOnce(async () => {
            mocks.announcements = [{ id: 'foreground', body: 'Returned in the foreground.', league_id: 'league', published_at: new Date().toISOString(), author_member_id: 'commissioner' }]
        })
        hidden = true
        await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
        hidden = false
        await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
        expect(mocks.refreshAnnouncements).not.toHaveBeenCalled()
        expect(screen.root.findAllByProps({ testID: 'home-announcement' })).toHaveLength(0)
        expect(screen.root.findByType('ScoreCard' as React.ElementType)).toBe(card)
    } finally {
        await act(async () => screen.unmount())
        vi.unstubAllGlobals()
    }
})

it('routes player identity to the profile and points to the scoring sheet', async () => {
    populatedStarters()
    mocks.push.mockClear()
    await mount()
    const row = rows('PG')[0]
    const player = row.props.myPlayer
    await act(async () => row.props.onOpenPlayer(player))
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/player/[id]', params: { id: player.playerId } })
    expect(screen.root.findByType('ScoreBreakdownSheet' as React.ElementType).props.visible).toBe(false)
    await act(async () => row.props.onOpenDetails({ myPlayer: player, oppPlayer: row.props.oppPlayer, slotType: 'PG' }))
    expect(screen.root.findByType('ScoreBreakdownSheet' as React.ElementType).props.visible).toBe(true)
    expect(mocks.push).toHaveBeenCalledTimes(1)
})

it('shows the matchup and lineup immediately without daily cards or a toggle', async () => {
    await mount(false)
    const types = screen.root.findAll(node => typeof node.type === 'string').map(node => String(node.type))
    expect(types).toContain('ScoreCard')
    expect(types).not.toContain('InlineLineupEditor')
    expect(types).not.toContain('DailyWaivers')
    expect(types).not.toContain('TimelineEntry')
    expect(types).not.toContain('Scoreboard')
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Toggle matchup details' })).toHaveLength(0)
    expect(rows('BE')).toHaveLength(3)
})

it('keeps the score header day strip and rows inside one vertical scroller', async () => {
    await act(async () => { screen = create(React.createElement(HomeScreen)) })
    const scrollers = screen.root.findAllByType('ScrollView' as React.ElementType).filter(node => !node.props.horizontal)
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0].props.stickyHeaderIndices).toBeUndefined()
    expect(scrollers[0].findAllByType('ScoreCard' as React.ElementType)).toHaveLength(1)
    expect(scrollers[0].findAllByType('DaySelector' as React.ElementType)).toHaveLength(1)
    expect(scrollers[0].findAllByType('MatchupRow' as React.ElementType).length).toBeGreaterThan(0)
})

it('places the current week strip below the lineup and opens a read-only matchup', async () => {
    mocks.leagueMatchups = [{ id: 'other-matchup', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 12, awayPoints: 10, isMine: false, isFinalized: false }]
    await mount()
    const scroll = screen.root.findByProps({ testID: 'matchup-page-scroll' })
    const strip = scroll.findByType(OtherMatchups)
    expect(strip.props.matchups).toEqual(mocks.leagueMatchups)
    expect(scroll.findAllByProps({ accessibilityLabel: 'Open Owls versus Foxes' })).toHaveLength(1)
    await act(async () => strip.props.onOpen('other-matchup'))
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/(modals)/matchup', params: { matchupId: 'other-matchup' } })
})

vi.mock('@/lib/timezone', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/timezone')>(), todayLeague: () => '2026-10-11' }))
