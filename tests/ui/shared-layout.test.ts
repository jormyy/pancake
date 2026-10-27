import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { webkit } from 'playwright'
import { View } from 'react-native'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { headerPlayer } from '../helpers/fixtures'
import { PageHeader } from '@/components/ui/Page'
import { LineupControls } from '@/components/ui/LineupControls'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SectionBand } from '@/components/ui/SectionBand'
import { ListHeader } from '@/components/ui/ListHeader'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { PlayerRow } from '@/components/ui/PlayerRow'
import { DaySelector } from '@/components/DaySelector'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { themeVariablesCss } from '@/constants/tokens'

vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web'), useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@/components/Motion', async () => ({ MotionPressable: (await vi.importActual<{ Pressable: typeof import('react-native')['Pressable'] }>('react-native-web')).Pressable }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: View }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('fits shared controls at phone widths and enlarged text', async () => {
    const directory = process.env.PANCAKE_LAYOUT_OUTPUT
    if (!directory) throw new Error('PANCAKE_LAYOUT_OUTPUT is required')
    await mkdir(directory, { recursive: true })
    const actions = [
        { title: 'Today', label: 'Auto-set today', onPress: () => {} },
        { title: 'This week', label: 'Auto-set this week', onPress: () => {} },
        { title: 'Rest of season', label: 'Auto-set rest of season', onPress: () => {} },
    ]
    const Fixture = () => React.createElement(PlayerEligibilityContext.Provider, { value: 2 }, React.createElement(View, null,
        React.createElement(View, { testID: 'compact-header' }, React.createElement(PageHeader, { title: 'Week 23 lineup', compact: true, onBack: () => {}, backLabel: 'Close lineup' })),
        React.createElement(View, { testID: 'lineup-controls', style: { paddingHorizontal: 12 } }, React.createElement(LineupControls, { actions, automatic: true, onAutomaticChange: () => {} })),
        React.createElement(DaySelector, { compact: true, days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-${20 + index}`, dateNum: 20 + index, dayLabel: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'][index], hasGames: true, isToday: false, playingTeams: [] })), selectedDate: '2026-10-22', onSelect: () => {} }),
        React.createElement(SectionBand, { label: 'Starters', variant: 'action', detail: React.createElement(Button, { title: 'Auto-set', size: 'inline', accessibilityLabel: 'Open auto-set lineup options' }) }),
        React.createElement(View, { style: { padding: 8 } }, React.createElement(PlayerRow, { compact: true, name: 'A Very Long Player Name That Must Remain Visible', team: 'LAL', positions: ['PG', 'SG'], injuryStatus: 'Out', yearsExp: 0, stats: '0.0 FP · 0.0 mins' })),
        React.createElement(View, { style: { padding: 12 } }, React.createElement(PlayerHeader, { player: headerPlayer({ display_name: 'A Very Long Player Name That Must Remain Visible', years_exp: 2 }), compact: true, rosterStatus: { status: 'free_agent' }, leagueActive: true, action: { label: 'Claim', accessibilityLabel: 'Claim long-name player', onPress: () => {}, disabled: false, busy: false } })),
        React.createElement(ListHeader, { interactive: true }, React.createElement(Button, { title: 'FP', size: 'inline', accessibilityLabel: 'Sort by fantasy points' })),
        React.createElement(PageHeader, { title: 'League', tabs: React.createElement(SegmentedControl, { options: [{ label: 'Standings', value: 'standings' }, { label: 'Activity', value: 'activity', badge: 12 }], value: 'standings', onChange: () => {}, variant: 'tabs' }) }),
        React.createElement(View, { style: { padding: 12 } }, React.createElement(Input, { label: 'Player search', placeholder: 'Search players' })),
    ))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('SharedLayout', () => Fixture)
    const application = AppRegistry.getApplication('SharedLayout')
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeVariablesCss()}</style>${renderToStaticMarkup(application.getStyleElement())}</head><body style="margin:0">${renderToStaticMarkup(application.element)}</body></html>`
    const browser = await webkit.launch()
    try {
        for (const width of [390, 360]) for (const scale of [1, 1.3]) {
            const page = await browser.newPage({ viewport: { width, height: 844 } })
            await page.setContent(html)
            if (scale !== 1) await page.evaluate(scale => {
                const sizes = Array.from(document.querySelectorAll<HTMLElement>('body *')).map(element => ({ element, font: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight) }))
                for (const { element, font, line } of sizes) {
                    element.style.fontSize = `${font * scale}px`
                    if (Number.isFinite(line)) element.style.lineHeight = `${line * scale}px`
                }
            }, scale)
            await page.screenshot({ path: path.join(directory, `shared-webkit-${width}-scale-${scale}.png`) })
            const geometry = await page.evaluate(() => {
                const targets = Array.from(document.querySelectorAll('[role="button"],[role="tab"],[role="switch"],button,input'))
                    .filter(element => !element.closest('[aria-hidden="true"]'))
                    .map(element => { const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label'), x: box.x, y: box.y, width: box.width, height: box.height } })
                const clipped = Array.from(document.querySelectorAll<HTMLElement>('[dir="auto"]'))
                    .filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
                    .map(element => element.textContent)
                const overlaps = targets.flatMap((a, index) => targets.slice(index + 1).filter(b => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5).map(b => [a.label, b.label]))
                return { targets, clipped, overlaps, overflow: document.documentElement.scrollWidth > innerWidth, header: document.querySelector('[data-testid="compact-header"]')!.getBoundingClientRect().height }
            })
            await writeFile(path.join(directory, `shared-webkit-${width}-scale-${scale}.json`), JSON.stringify(geometry, null, 2))
            expect.soft(geometry.clipped).toEqual([])
            expect.soft(geometry.overflow).toBe(false)
            expect.soft(geometry.overlaps).toEqual([])
            expect.soft(geometry.targets.filter(target => target.width < 43.9 || target.height < 43.9)).toEqual([])
            if (scale === 1) expect.soft(geometry.header).toBe(49)
            await page.close()
        }
    } finally {
        await browser.close()
    }
}, 30000)
