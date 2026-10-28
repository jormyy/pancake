import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir } from 'node:fs/promises'
import { webkit, devices } from 'playwright'
import { expect, it, vi } from 'vitest'
import { View } from 'react-native'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { themeVariablesCss } from '@/constants/tokens'
import type { LeagueProjectionRow } from '@/lib/projections'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { rosterPlayer } from '@/tests/helpers/fixtures'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web') }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: false, revision: 0 }) }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:58821/functions/v1/api' }))

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('keeps player projections and trade asset values on one line at 390x844', async () => {
    const output = process.env.PANCAKE_LAYOUT_OUTPUT!
    const label = process.env.PANCAKE_LAYOUT_LABEL ?? 'after'
    await mkdir(output, { recursive: true })
    const projection = { next_game_date: '2099-10-28', next_game_time: '2099-10-29T01:00:00Z', next_game_opponent: 'vs SAS', projection_fantasy_points: 0,
        projection_source_label: 'Sleeper (RotoWire)', projection_fetched_at: '2026-10-27T15:30:00Z', projection_is_fresh: true } as LeagueProjectionRow
    const analysis = { strategy: 'balanced', confidence: 1, teams: [], assets: [
        { kind: 'player', assetId: 'player-a', label: 'Nickeil Alexander-Walker', values: { balanced: 473 }, components: { shortTermPoints: 8.7, longTermValue: 615 }, ranges: { balanced: { low: 416, high: 530 } }, confidence: 1 },
        { kind: 'pick', assetId: 'pick', label: '2027 Round 1 · Mike’s Minions', values: { balanced: 619 }, components: { shortTermPoints: 0, longTermValue: 705 }, ranges: { balanced: { low: 441, high: 796 } }, confidence: 0.7 },
    ], sources: [{ name: 'Sleeper (RotoWire)', fetchedAt: '2026-10-27T15:30:00Z' }], missingInputs: ['pick slot'], assumptions: ['Health changes value by no more than 12%.'] } as unknown as DynastyTradeAnalysis
    const player = rosterPlayer()
    player.players = { ...player.players, display_name: 'Nickeil Alexander-Walker', nba_team: 'ATL', eligible_positions: ['PG', 'SG'] }
    const Fixture = () => React.createElement(View, { style: { width: 390, padding: 16, gap: 16 } },
        React.createElement(NextProjectionCard, { projection }), React.createElement(TradeAnalysisSummary, { analysis, players: [player], participantName: String, inset: false }))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('PolishDetails', () => Fixture)
    const app = AppRegistry.getApplication('PolishDetails')
    const body = renderToStaticMarkup(app.element)
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeVariablesCss()}</style>${renderToStaticMarkup(app.getStyleElement())}</head><body style="margin:0">${body}</body></html>`
    const browser = await webkit.launch()
    try {
        const page = await browser.newPage({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 } })
        await page.setContent(html)
        await page.screenshot({ path: `${output}/details-${label}.png` })
        if (label === 'after') {
            expect(await page.getByText('Sources and limits', { exact: true }).count()).toBe(0)
            expect(await page.getByText('Value 473 · Now 8.7 · Long 615 · 416–530', { exact: true }).count()).toBe(1)
            const geometry = await page.getByText('Value 473 · Now 8.7 · Long 615 · 416–530', { exact: true }).evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight), clipped: node.scrollWidth > node.clientWidth }))
            expect(geometry.clipped).toBe(false)
            expect(geometry.height).toBeLessThanOrEqual(geometry.line)
        }
    } finally { await browser.close() }
}, 30000)
