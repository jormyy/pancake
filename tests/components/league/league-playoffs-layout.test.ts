import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { LeaguePlayoffs } from '@/components/league/LeaguePlayoffs'
import type { StandingRow } from '@/lib/scoring'

const state = vi.hoisted(() => ({ getBracket: vi.fn() }))

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => {
    const gate = { canRead: () => true, capture: () => 0, isCurrent: () => true }
    return { useDraftActivity: () => ({ ...gate, epoch: 0 }) }
})
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/lib/bracket', () => ({ getPlayoffBracket: state.getBracket }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/components/ui/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/ui', () => ({ ErrorBanner: 'ErrorBanner', LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/format', () => ({ formatPoints: (value: number) => String(value) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: () => {} }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const matchup = (id: string, homeName: string, awayName: string, week: number, endWeek: number | undefined, homePoints: number | null, awayPoints: number | null, isFinalized = false) => ({
    id, round: 'semifinal', weekNumber: week, endWeekNumber: endWeek,
    homeId: 'member', homeName, homePoints, awayId: 'other', awayName, awayPoints, winnerId: null, isFinalized,
})

const texts = (screen: ReactTestRenderer) => screen.root.findAllByType('Text' as React.ElementType).map(node => (node.children as unknown[]).join(''))

it('shows each round once and one single-line row per matchup', async () => {
    state.getBracket.mockResolvedValue({
        quarterfinals: [], champion: null, final: null,
        rounds: [
            { number: 1, label: 'Semifinals', matchups: [matchup('s1', 'Owls', 'Foxes', 20, 21, 112.4, 98.2)] },
            { number: 2, label: 'Championship', matchups: [matchup('f1', 'Hawks', 'Jays', 22, undefined, null, null)] },
        ],
    })
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(LeaguePlayoffs, { standings: [], playoffEntrants: 4 })) })
    try {
        expect(screen.root.findAllByProps({ children: 'Semifinals · Weeks 20–21' })).toHaveLength(1)
        expect(screen.root.findAllByProps({ children: 'Weeks 20–21' })).toHaveLength(0)
        expect(screen.root.findAllByProps({ children: 'Championship · Week 22' })).toHaveLength(1)
        expect(screen.root.findAllByType('Badge' as React.ElementType).map(node => node.props.label)).toEqual(['Live', 'Upcoming'])
        expect(screen.root.findByProps({ accessibilityLabel: 'Open Owls versus Foxes' })).toBeTruthy()
        expect(screen.root.findByProps({ accessibilityLabel: 'Open Hawks versus Jays' })).toBeTruthy()
        const all = texts(screen)
        expect(all).toContain('112.4 – 98.2')
        expect(all.filter(text => text.includes('Weeks 20–21'))).toHaveLength(1)
        expect(all).not.toContain('—')
    } finally {
        await act(async () => screen.unmount())
    }
})

it('names projected rounds once without matchup week headers or actions', async () => {
    state.getBracket.mockResolvedValue(null)
    const standings: StandingRow[] = Array.from({ length: 4 }, (_, index) => ({ memberId: `team-${index}`, teamName: `Team ${index}`, wins: 4 - index, losses: index, ties: 0, pointsFor: 100, maxPointsFor: 200, pointsAgainst: 100 }))
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(LeaguePlayoffs, { standings, playoffEntrants: 4 })) })
    try {
        const all = texts(screen)
        expect(all.filter(text => text === 'Semifinals')).toHaveLength(1)
        expect(all.filter(text => text === 'Championship')).toHaveLength(1)
        expect(all).toContain('Projected bracket — based on current standings')
        expect(screen.root.findAllByType('MotionPressable' as React.ElementType)).toHaveLength(0)
        expect(all).not.toContain('—')
    } finally {
        await act(async () => screen.unmount())
    }
})
