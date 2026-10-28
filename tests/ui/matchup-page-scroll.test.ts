import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir, writeFile } from 'node:fs/promises'
import { webkit } from 'playwright'
import { expect, it, vi } from 'vitest'
import { ScrollView, View } from 'react-native'
import { ScoreCard } from '@/components/ScoreCard'
import { DaySelector } from '@/components/DaySelector'
import { MatchupLineupView } from '@/components/MatchupLineupView'
import type { Matchup } from '@/lib/scoring'
import { themeVariablesCss } from '@/constants/tokens'

vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web') }))
vi.mock('@/components/Motion', async () => { const { View, Pressable } = await vi.importActual<{ View: React.ComponentType; Pressable: React.ComponentType }>('react-native-web'); return { MotionView: View, MotionPressable: Pressable, LivePulse: View } })
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('scrolls the matchup header day strip and rows as one page in WebKit at 390x844', async () => {
    const output = process.env.PANCAKE_LAYOUT_OUTPUT!
    await mkdir(output, { recursive: true })
    const player = (index: number) => ({ rosterPlayerId: `roster-${index}`, playerId: `player-${index}`, displayName: `Player ${index}`, position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'BOS', injuryStatus: null, nbaId: null })
    const lineup = { starters: [{ slotType: 'PG', player: player(0) }], bench: Array.from({ length: 20 }, (_, index) => player(index + 1)), benchSlots: 20, ir: [], taxi: [] }
    const matchup = { weekNumber: 1, myTeamName: 'Matthew', opponentTeamName: 'Michael', myPoints: 100, opponentPoints: 90 } as Matchup
    const Fixture = () => React.createElement(View, { style: { height: 844 } }, React.createElement(ScrollView, { testID: 'matchup-page-scroll', style: { flex: 1 } },
        React.createElement(View, { testID: 'matchup-page-header' }, React.createElement(ScoreCard, { matchup, compact: true })),
        React.createElement(MatchupLineupView, { myMemberId: 'me', opponentMemberId: 'other', myLineup: lineup, oppLineup: lineup, selected: null, getTargetState: () => null, onTap: () => {}, saving: false, playingTeams: new Set<string>(), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map(), statColumns: null, onOpenDetails: () => {}, onOpenPlayer: () => {}, playerForecasts: new Map(), forecastStale: false, capacity: { bench: 20, ir: 2, taxi: 3 }, compact: true, dense: false,
            daySelector: React.createElement(View, { testID: 'matchup-day-strip' }, React.createElement(DaySelector, { days: [{ date: '2026-10-27', dateNum: 27, dayLabel: 'Tue', isToday: true, hasGames: true, playingTeams: ['BOS'] }], selectedDate: '2026-10-27', onSelect: () => {}, compact: true })) })))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('MatchupPageScroll', () => Fixture)
    const app = AppRegistry.getApplication('MatchupPageScroll')
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}${themeVariablesCss()}</style>${renderToStaticMarkup(app.getStyleElement())}</head><body>${renderToStaticMarkup(app.element)}</body></html>`
    const browser = await webkit.launch()
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
        await page.route('**/*', route => route.abort())
        await page.setContent(html)
        const measure = () => page.evaluate(() => {
            const root = document.querySelector('[data-testid="matchup-page-scroll"]')!
            const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top
            return { header: rect('[data-testid="matchup-page-header"]'), day: rect('[data-testid="matchup-day-strip"]'), row: rect('[data-testid="matchup-player-name"]'), scroll: root.scrollTop,
                scrollers: Array.from(document.querySelectorAll('*')).filter(node => { const style = getComputedStyle(node); return ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1 }).length }
        })
        const before = await measure()
        await page.locator('[data-testid="matchup-page-scroll"]').evaluate(node => { node.scrollTop = 420 })
        const after = await measure()
        expect(after.scroll).toBe(420)
        expect(after.scrollers).toBe(1)
        expect(after.header).toBeLessThan(-100)
        for (const key of ['header', 'day', 'row'] as const) expect(before[key] - after[key]).toBe(420)
        await page.screenshot({ path: `${output}/matchup-page-scroll.png` })
        await writeFile(`${output}/matchup-page-scroll.json`, JSON.stringify({ viewport: { width: 390, height: 844 }, before, after }, null, 2))
    } finally { await browser.close() }
}, 30000)
