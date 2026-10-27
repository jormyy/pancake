import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir } from 'node:fs/promises'
import { webkit, devices } from 'playwright'
import { expect, it, vi } from 'vitest'
import { View } from 'react-native'
import { MatchupRow } from '@/components/MatchupRow'
import { themeVariablesCss } from '@/constants/tokens'

vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web') }))
vi.mock('@/components/Motion', async () => {
    const { View, Pressable } = await vi.importActual<{ View: React.ComponentType; Pressable: React.ComponentType }>('react-native-web')
    return { MotionView: View, MotionPressable: Pressable, LivePulse: View }
})
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:58821/functions/v1/api' }))
vi.mock('@/lib/scoring', () => ({ computeLiveFantasyPoints: () => 0 }))

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('keeps mirrored long names on one line with 44px controls at 390x844', async () => {
    const output = process.env.PANCAKE_LAYOUT_OUTPUT!
    const label = process.env.PANCAKE_LAYOUT_LABEL ?? 'after'
    await mkdir(output, { recursive: true })
    const player = (displayName: string, injuryStatus: string) => ({
        rosterPlayerId: displayName, playerId: displayName, displayName, position: 'C', eligiblePositions: ['C'], nbaTeam: 'SAS', injuryStatus, nbaId: null,
    })
    const Fixture = () => React.createElement(View, { style: { width: 390, padding: 16 } },
        ...['Victor Wembanyama', 'Nickeil Alexander-Walker', 'Gary Trent Jr.'].map((name, index) => React.createElement(MatchupRow, {
            key: name, myPlayer: player(name, 'DTD'), oppPlayer: player(name, 'Out'), slotType: 'C', selKind: 'starter', selIndex: index,
            isSelected: false, onTap: () => {}, saving: false, compact: true, playingTeams: new Set(['SAS']), liveStats: new Map(),
            liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map([['SAS', { opponent: 'LAL', isHome: false }]]),
            onOpenPlayer: () => {}, onOpenDetails: () => {},
        })))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('MatchupPolish', () => Fixture)
    const app = AppRegistry.getApplication('MatchupPolish')
    const body = renderToStaticMarkup(app.element)
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeVariablesCss()}</style>${renderToStaticMarkup(app.getStyleElement())}</head><body style="margin:0">${body}</body></html>`
    const browser = await webkit.launch()
    try {
        const page = await browser.newPage({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 } })
        await page.setContent(html)
        await page.screenshot({ path: `${output}/matchup-stress-${label}.png` })
        const geometry = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            names: Array.from(document.querySelectorAll('[data-testid="matchup-player-name"]')).map(node => ({ text: node.textContent, height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight), clipped: node.scrollWidth > node.clientWidth, overflowStyle: getComputedStyle(node).textOverflow })),
            targets: Array.from(document.querySelectorAll('[role="button"]')).map(node => ({ label: node.getAttribute('aria-label'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
        }))
        if (label === 'after') {
            expect(geometry.overflow).toBe(false)
            expect(geometry.names).toHaveLength(6)
            for (const name of geometry.names) {
                expect(name.height).toBeLessThanOrEqual(name.line)
                expect(name.clipped).toBe(false)
                expect(name.overflowStyle).toBe('clip')
            }
            for (const target of geometry.targets) {
                expect(target.width, target.label ?? '').toBeGreaterThanOrEqual(44)
                expect(target.height, target.label ?? '').toBeGreaterThanOrEqual(44)
            }
        }
    } finally { await browser.close() }
}, 30000)
