import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { SeasonSelector as WebSeasonSelector } from '@/components/player/SeasonSelector.web'
import { StatsOverview } from '@/components/player/StatsOverview'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHistory } from '@/components/player/PlayerHistory'
import { headerPlayer } from '@/tests/helpers/fixtures'
import type { GameLogEntry, PlayerSeasonAverages } from '@/lib/players'
import type { LeagueProjectionRow } from '@/lib/projections'

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('@/components/ui', () => ({ Card: 'Card', FilterSelect: 'FilterSelect' }))
vi.mock('@/components/ui/useEdgeFade', () => ({ useEdgeFade: () => ({}) }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/player/TransactionHistory', () => ({ TransactionHistory: 'TransactionHistory' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: (player: { eligible_positions: string[] }) => player.eligible_positions }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const type = (name: string) => name as React.ElementType
const text = () => screen.root.findAllByType(type('Text')).map(node => node.props.children).flat().join(' ')
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })
const render = async (element: React.ReactElement) => { await act(async () => { screen = create(element) }) }

const averages: PlayerSeasonAverages = {
    gamesPlayed: 30, avgPoints: 21.2, avgRebounds: 5.3, avgAssists: 8.4, avgSteals: 1.5, avgBlocks: 0.6,
    avgTurnovers: 2.7, avgThreePointersMade: 3.8, avgMinutesPlayed: 34.9,
    avgFieldGoalsMade: 8, avgFieldGoalsAttempted: 16, avgFreeThrowsMade: 4, avgFreeThrowsAttempted: 5,
    doubleDoubles: 8, tripleDoubles: 2,
}
const game = (overrides: Partial<GameLogEntry> = {}): GameLogEntry => ({
    gameId: 'latest', gameDate: '2026-10-22', opponent: 'vs BOS', isHome: true, didNotPlay: false,
    minutes: 34, points: 24, rebounds: 5, assists: 8, steals: 2, blocks: 1, turnovers: 3,
    personalFouls: 2, fgMade: 8, fgAttempted: 16, threeMade: 3, threeAttempted: 7,
    ftMade: 5, ftAttempted: 6, plusMinus: 8, doubleDouble: false, tripleDouble: false, ...overrides,
})

describe('season dropdown', () => {
    it.each([{ seasons: [] }, { seasons: [2027] }])('hides the control when there is no choice: %j', async ({ seasons }) => {
        await render(React.createElement(WebSeasonSelector, { seasons, selectedSeason: 2027, onSelect: vi.fn() }))
        expect(screen.toJSON()).toBeNull()
    })

    it('exposes one native web select with the selected season and numeric changes', async () => {
        const onSelect = vi.fn()
        await render(React.createElement(WebSeasonSelector, { seasons: [2027, 2026, 2025], selectedSeason: 2027, onSelect }))
        const select = screen.root.findByType('select')
        expect(select.props['aria-label']).toBe('Season')
        expect(select.props.value).toBe(2027)
        expect(select.findAllByType('option').map(node => node.props.value)).toEqual([2027, 2026, 2025])
        await act(async () => select.props.onChange({ currentTarget: { value: '2026' } }))
        expect(onSelect).toHaveBeenCalledWith(2026)
        expect(screen.root.findAllByType(type('Pressable'))).toHaveLength(0)
    })

    it('uses at least 16-pixel select text to avoid iPhone focus zoom', async () => {
        await render(React.createElement(WebSeasonSelector, { seasons: [2027, 2026], selectedSeason: 2027, onSelect: vi.fn() }))
        expect(screen.root.findByType('select').props.style.fontSize).toBeGreaterThanOrEqual(16)
    })

    it('uses the shared picker on native platforms', async () => {
        const onSelect = vi.fn()
        await render(React.createElement(SeasonSelector, { seasons: [2027, 2026], selectedSeason: 2027, onSelect }))
        const picker = screen.root.findByType(type('FilterSelect'))
        expect(picker.props.value).toBe('2027')
        expect(picker.props.options).toEqual([{ key: '2027', label: '2026–27' }, { key: '2026', label: '2025–26' }])
        await act(async () => picker.props.onChange('2026'))
        expect(onSelect).toHaveBeenCalledWith(2026)
    })
})

describe('player decision summary', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T18:00:00Z')) })
    const actions = { onAdd: vi.fn(), onDrop: vi.fn(), onClaim: vi.fn(), onSetLineup: vi.fn() }
    it.each([
        [{ status: 'free_agent' as const }, 'Free agent', ['Add Player A']],
        [{ status: 'on_waivers' as const, logId: 'waiver', clearsAt: '2099-01-01' }, 'On waivers', ['Claim Player A']],
        [{ status: 'mine' as const, rosterPlayerId: 'roster' }, 'On your roster', ['Move Player A in lineup', 'Drop Player A']],
        [{ status: 'taken' as const, ownerTeamName: 'Maple Hoops' }, 'Maple Hoops', []],
    ])('shows roster status and the available actions for %j', async (rosterStatus, status, labels) => {
        await render(React.createElement(PlayerHeader, {
            player: headerPlayer({ injury_status: 'GTD' }), rosterStatus, leagueActive: true,
            actionLoading: false, compact: true, ...actions,
        }))
        expect(text()).toContain('Player A')
        expect(text()).toContain('LAL')
        expect(text()).toContain(status)
        expect(screen.root.findAllByType(type('Badge')).map(node => node.props.label)).toContain('GTD')
        expect(screen.root.findByType(type('PosTag')).props.position).toBe('PG')
        expect(screen.root.findAllByType(type('Pressable')).map(node => node.props.accessibilityLabel)).toEqual(labels)
    })

    it('keeps rank and experience visible without layout measurements', async () => {
        await render(React.createElement(PlayerHeader, {
            player: headerPlayer({ dynasty_rank: 8, years_exp: 6, injury_status: 'GTD' }),
            rosterStatus: { status: 'free_agent' }, leagueActive: true, compact: true, ...actions,
        }))
        expect(screen.root.findAllByType(type('Badge')).map(node => node.props.label)).toEqual(['GTD', 'Dynasty #8', 'Yr 7'])
        expect(screen.root.findAllByType(type('View')).filter(node => typeof node.props.onLayout === 'function')).toHaveLength(0)
        expect(screen.root.findByProps({ accessibilityLabel: 'Player A' }).props.numberOfLines).toBe(2)
    })

    it('reserves a fixed action slot from the first frame and takes its label from props', async () => {
        const props = { player: headerPlayer(), rosterStatus: null, leagueActive: true, compact: true }
        await render(React.createElement(PlayerHeader, props))
        const slot = () => screen.root.findByProps({ testID: 'player-action-slot' })
        const initialStyle = slot().props.style
        expect(slot().props['aria-busy']).toBe(true)
        expect(slot().findAllByType(type('View')).length).toBeGreaterThan(0)
        const onPress = vi.fn()
        for (const busy of [false, true, false]) {
            await act(async () => screen.update(React.createElement(PlayerHeader, {
                ...props, rosterStatus: { status: 'free_agent' }, action: { label: 'Add to IR', onPress, disabled: false, busy },
            })))
            expect(slot().props.style).toEqual(initialStyle)
            const buttons = screen.root.findAllByType(type('Pressable'))
            expect(buttons).toHaveLength(1)
            expect(buttons[0].props.disabled).toBe(busy)
            expect(text()).toContain('Add to IR')
        }
        await act(async () => screen.root.findByType(type('Pressable')).props.onPress())
        expect(onPress).toHaveBeenCalledOnce()
    })

    it.each([
        { status: { status: 'free_agent' as const }, label: 'Free agent', injury: null, action: 'Add Player A' },
        { status: { status: 'mine' as const, rosterPlayerId: 'roster' }, label: 'On your roster', injury: null, action: 'Drop Player A' },
        { status: { status: 'on_waivers' as const, logId: 'waiver', clearsAt: '2099-01-01' }, label: 'On waivers', injury: null, action: 'Claim Player A' },
        { status: { status: 'free_agent' as const }, label: 'Free agent', injury: 'OUT', action: 'Add Player A' },
    ])('aligns $label and its action with the name, including injury $injury', async ({ status, label, injury, action }) => {
        const onAdd = vi.fn()
        await render(React.createElement(PlayerHeader, {
            player: headerPlayer({ injury_status: injury }), rosterStatus: status, leagueActive: true,
            actionLoading: false, compact: true, ...actions, onAdd,
            addBlockedReason: status.status === 'free_agent' ? 'Add limit reached' : null,
            addBlockedCaption: 'Adds 7/7',
        }))
        const name = screen.root.findAllByType(type('Text')).find(node => node.props.children === 'Player A')!
        const roster = screen.root.findAllByType(type('Text')).find(node => node.props.children === label)!
        expect(roster.parent === name.parent?.parent?.children[1]).toBe(true)
        const styles = Object.assign({}, ...[roster.parent?.props.style].flat(Infinity).filter(Boolean))
        expect(styles.alignItems).toBe('center')
        const button = screen.root.findByProps({ accessibilityLabel: action })
        expect(name.parent?.findAllByProps({ accessibilityLabel: action })).toHaveLength(1)
        if (status.status === 'free_agent') {
            const caption = screen.root.findByProps({ children: 'Adds 7/7' })
            expect(caption.parent === name.parent?.parent).toBe(true)
            await act(async () => button.props.onPress())
            expect(onAdd).toHaveBeenCalledOnce()
        }
    })

    it('puts injury before the other metadata on narrow screens', async () => {
        await render(React.createElement(PlayerHeader, {
            player: headerPlayer({ nba_team: 'LAC', eligible_positions: ['PG', 'SG', 'SF'], dynasty_rank: 100, injury_status: 'Out' }),
            rosterStatus: { status: 'free_agent' }, leagueActive: true, actionLoading: false, compact: true, ...actions,
        }))
        const injury = screen.root.findAllByType(type('Badge')).find(node => node.props.label === 'Out')!
        const core = injury.parent!
        expect(core.children[0] === injury).toBe(true)
        expect(core.findAllByType(type('PosTag'))).toHaveLength(3)
        expect(core.findAllByType(type('Badge')).map(node => node.props.label)).toContain('Dynasty #100')
    })

    it('never calls a started game next and shows live points from the log', async () => {
        const projection = { next_game_date: '2026-10-24', next_game_time: '2026-10-24T17:00:00Z',
            next_game_opponent: 'vs BOS', projection_fantasy_points: 42.8 } as LeagueProjectionRow
        await render(React.createElement(NextProjectionCard, { projection,
            liveGame: { ...game(), live: true, nbaGameId: 'game' }, liveFantasyPoints: 12.4 }))
        expect(text()).toContain('Live vs BOS · 12.4 FP so far')
        expect(text()).not.toContain('42.8')
        await act(async () => screen.update(React.createElement(NextProjectionCard, {
            projection: { ...projection, next_game_date: '2026-10-25', next_game_time: '2026-10-25T23:00:00Z', next_game_opponent: '@ DEN' },
            liveGame: { ...game(), live: true, nbaGameId: 'game' }, liveFantasyPoints: 12.4,
        })))
        expect(text()).not.toContain('@ DEN')
        expect(text()).toBe('Live vs BOS · 12.4 FP so far')
    })

    it('removes the next projection at tipoff without polling', async () => {
        const projection = { next_game_date: '2026-10-24', next_game_time: '2026-10-24T18:00:01Z',
            next_game_opponent: 'vs BOS', projection_fantasy_points: 42.8 } as LeagueProjectionRow
        await render(React.createElement(NextProjectionCard, { projection }))
        expect(text()).toContain('42.8')
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(screen.toJSON()).toBeNull()
    })

    it('keeps ten decision stats, with fantasy points first and one season control', async () => {
        await render(React.createElement(StatsOverview, {
            averages, seasonYear: 2027, avgFantasyPoints: 42.3, columns: 5,
            seasonControl: React.createElement(WebSeasonSelector, { seasons: [2027, 2026], selectedSeason: 2027, onSelect: vi.fn() }),
        }))
        const cells = screen.root.findAll(node => node.props.accessible === true)
        expect(cells).toHaveLength(10)
        expect(cells[0].props.accessibilityLabel).toBe('42.3 fantasy points per game')
        for (const value of ['FP/G', 'GP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO']) expect(text()).toContain(value)
        expect(text()).not.toContain('FG%')
        expect(text()).not.toContain('double-double')
        expect(screen.root.findAllByType('select')).toHaveLength(1)
    })

    it('shows the next opponent, date and projection without expanding details', async () => {
        const projection = {
            next_game_date: '2026-10-24', projection_date: '2026-10-23', next_game_opponent: 'vs BOS',
            next_game_time: '2026-10-24T23:00:00Z', projection_fantasy_points: 42.8,
            projection_source_label: 'FantasyPros', projection_is_fresh: false,
        } as LeagueProjectionRow
        await render(React.createElement(NextProjectionCard, { projection }))
        expect(text()).toMatch(/^vs BOS · Sat .+ · 42\.8 FP proj$/)
        expect(screen.root.findByType(type('Text')).props.numberOfLines).toBe(1)
        expect(text()).toContain('42.8')
        expect(text()).toContain('FP')
    })
})

it('keeps fantasy points before counting stats and preserves older-game pagination', async () => {
    const onLoadMore = vi.fn()
    await render(React.createElement(GameLogTable, {
        games: [game(), game({ gameId: 'dnp', gameDate: '2026-10-20', didNotPlay: true })],
        fantasyPointsMap: new Map([['latest', 45.2], ['dnp', 99]]), hasMore: true, loadingMore: false, onLoadMore,
    }))
    expect(text().indexOf('FP')).toBeLessThan(text().indexOf('MIN'))
    expect(text()).toContain('45.2')
    expect(text()).toContain('DNP')
    expect(text()).not.toContain('99.0')
    const more = screen.root.findByType(type('Pressable'))
    await act(async () => more.props.onPress())
    expect(onLoadMore).toHaveBeenCalledOnce()
    await act(async () => screen.update(React.createElement(GameLogTable, {
        games: [game()], fantasyPointsMap: null, hasMore: true, loadingMore: true, onLoadMore,
    })))
    expect(screen.root.findByType(type('Pressable')).props.disabled).toBe(true)
})

it('keeps history collapsed until requested and omits empty history', async () => {
    const props = { playerId: 'player', leagueId: 'league', transactions: [{ id: 'tx', transactionType: 'drop', label: 'Dropped', teamName: 'Maple Hoops', occurredAt: '2026-10-22' }] }
    await render(React.createElement(PlayerHistory, props))
    expect(screen.root.findAllByType(type('TransactionHistory'))).toHaveLength(0)
    const toggle = screen.root.findByType(type('Pressable'))
    expect(toggle.props['aria-expanded']).toBe(false)
    await act(async () => toggle.props.onPress())
    expect(screen.root.findByType(type('TransactionHistory')).props.transactions).toEqual(props.transactions)
    await act(async () => screen.update(React.createElement(PlayerHistory, { ...props, transactions: [] })))
    expect(screen.toJSON()).toBeNull()
})
