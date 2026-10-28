import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir, writeFile } from 'node:fs/promises'
import { webkit } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import OtherMatchupScreen from '@/app/(modals)/matchup'
import { Button } from '@/components/ui/Button'
import { ScoreCard } from '@/components/ScoreCard'
import { MatchupLineupView } from '@/components/MatchupLineupView'
import { MatchupForecastSummary } from '@/components/MatchupForecastSummary'
import { DaySelector } from '@/components/DaySelector'
import { OtherMatchups } from '@/components/OtherMatchups'
import { themeVariablesCss } from '@/constants/tokens'
import type { Matchup } from '@/lib/scoring'

const state = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn(), setDate: vi.fn(), canBack: true }))
vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web'), useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@/components/Motion', async () => { const { View, Pressable } = await vi.importActual<typeof import('react-native')>('react-native-web'); return { MotionView: View, MotionPressable: Pressable, LivePulse: View } })
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('react-native-safe-area-context', async () => { const { View } = await vi.importActual<typeof import('react-native')>('react-native-web'); return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) } })
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ matchupId: 'other' }), useRouter: () => ({ back: state.back, replace: state.replace, push: state.push, canGoBack: () => state.canBack }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'actor' }, currentLeague: { id: 'league', ir_slots: 0, taxi_slots: 0, scoring_settings: { points: 1 } }, membershipValidated: true }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'account' } }) }))
vi.mock('@/hooks/use-matchup-data', () => ({ useMatchupData: () => payload() }))
vi.mock('@/components/ScoreBreakdownSheet', () => ({ ScoreBreakdownSheet: () => null }))

const player = (id: string) => ({ rosterPlayerId: id, playerId: id, displayName: id, position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'BOS', injuryStatus: null, nbaId: null })
const lineup = (id: string) => ({ starters: [{ slotType: 'PG', player: player(id) }], bench: [player(`${id} Bench`)], benchSlots: 1, ir: [], taxi: [] })
const matchup = { id: 'other', weekNumber: 1, myTeamName: 'Owls', opponentTeamName: 'Foxes', myWins: 2, myLosses: 1, opponentWins: 1, opponentLosses: 2, myPoints: 100, opponentPoints: 90, myMemberId: 'a', opponentMemberId: 'b' } as Matchup
function payload() {
    return { leagueMatchups: [{ id: 'other', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 100, awayPoints: 90, isMine: false, isFinalized: false }], matchup, myLineup: lineup('Jayson Tatum'), oppLineup: lineup('Jaylen Brown'), selectedDate: '2026-10-27', setSelectedDate: state.setDate, weekDays: [{ date: '2026-10-27', dayLabel: 'Tue', dateNum: 27, isToday: true, hasGames: true, playingTeams: ['BOS'] }],
        forecastState: { forecast: { teams: [{ memberId: 'a', currentPoints: 100, projectedFinal: 150, winProbability: 0.65 }, { memberId: 'b', currentPoints: 90, projectedFinal: 130, winProbability: 0.35 }], games: [] }, pending: false, error: false, stale: false },
        liveSnapshot: { todaysGames: [], freshness: 'fresh', liveStats: new Map(['Jayson Tatum', 'Jaylen Brown', 'Jayson Tatum Bench', 'Jaylen Brown Bench'].map(id => [id, { points: 12, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, threeMade: 0, fgMade: 0, fgAttempted: 0, ftMade: 0, ftAttempted: 0, doubleDouble: false, tripleDouble: false }])), teamMatchups: new Map() }, error: null, emptyConfirmed: false, refresh: () => {},
    }
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined; state.canBack = true; vi.clearAllMocks() })
it('renders the shared Home components with read-only rows and no lineup actions', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchupScreen)) })
    expect(screen!.root.findByType(ScoreCard).props.matchup).toEqual(matchup)
    expect(screen!.root.findByType(MatchupForecastSummary).props.myMemberId).toBe('a')
    const lineup = screen!.root.findByType(MatchupLineupView)
    expect(lineup.props.readOnly).toBe(true)
    expect(lineup.props.autoSetControl).toBeUndefined()
    const slots = screen!.root.findAll(node => typeof node.type === 'string' && String(node.props['aria-label'] ?? '').startsWith('Select '))
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) expect(slot.props['aria-disabled']).toBe(true)
    await act(async () => screen!.root.findByType(DaySelector).props.onSelect('2026-10-28'))
    expect(state.setDate).toHaveBeenCalledWith('2026-10-28')
})
it('removes the back row', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchupScreen)) })
    expect(screen!.root.findAllByType(Button)).toHaveLength(0)
})
it('opens another matchup from the shared strip below the lineup', async () => {
    await act(async () => { screen = create(React.createElement(OtherMatchupScreen)) })
    const strip = screen!.root.findByType(OtherMatchups)
    expect(strip.props.matchups).toEqual(payload().leagueMatchups)
    expect(strip.props.currentMatchupId).toBe('other')
    expect(screen!.root.findAll(node => typeof node.type === 'string' && node.props['aria-current'] === 'true')).toHaveLength(1)
    const content = strip.parent!
    expect(content.children.at(-1)).toBe(strip)
    await act(async () => strip.props.onOpen('next-matchup'))
    expect(state.replace).toHaveBeenCalledExactlyOnceWith({ pathname: '/(modals)/matchup', params: { matchupId: 'next-matchup' } })
})
it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('fits the other matchup and strip in WebKit at 390x844', async () => {
    const output = process.env.PANCAKE_LAYOUT_OUTPUT!
    await mkdir(output, { recursive: true })
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    const browser = await webkit.launch()
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
        await page.route('**/*', route => route.abort())
        for (const [name, Component] of [
            ['screen', OtherMatchupScreen],
            ['strip', () => React.createElement(OtherMatchups, { matchups: [{ id: 'other', homeMemberId: 'a', awayMemberId: 'b', homeTeamName: 'Owls', awayTeamName: 'Foxes', homePoints: 100, awayPoints: 90, isMine: false, isFinalized: false }], onOpen: () => {} })],
        ] as const) {
            AppRegistry.registerComponent(name, () => Component)
            const app = AppRegistry.getApplication(name)
            await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}${themeVariablesCss()}</style>${renderToStaticMarkup(app.getStyleElement())}</head><body>${renderToStaticMarkup(app.element)}</body></html>`)
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
            const text = await page.locator('body').innerText()
            expect(text).toContain('Owls'); expect(text).toContain('Foxes')
            if (name === 'screen') {
                for (const label of ['WEEK 1', '2-1', '1-2', '150 proj', '65% win', '130 proj', '35% win', 'STARTERS', 'BENCH', '12']) expect(text).toContain(label)
                expect(text).not.toContain('Auto-set')
                expect(await page.getByRole('button', { name: 'Back to Home', exact: true }).count()).toBe(0)
                expect(await page.getByTestId('other-matchups').count()).toBe(1)
                const stripBox = await page.getByTestId('other-matchups').boundingBox()
                const lineupBox = await page.getByTestId('matchup-player-name').last().boundingBox()
                expect(stripBox!.y).toBeGreaterThan(lineupBox!.y + lineupBox!.height)
                const names = await page.getByTestId('matchup-player-name').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) })))
                expect(names).toHaveLength(4)
                for (const name of names) expect(name.height).toBeLessThanOrEqual(name.line)
            } else expect(text).toContain('Other matchups')
            await page.screenshot({ path: `${output}/other-matchup-${name}.png`, fullPage: true })
            await writeFile(`${output}/other-matchup-${name}.txt`, text)
        }
    } finally { await browser.close() }
}, 30000)

it.skipIf(!process.env.PANCAKE_MATCHUP_STACK)('verifies the restored forecast and header layouts through the private stack', async () => {
    await import('../e2e/matchup-projection-layout.mjs')
}, 360000)
