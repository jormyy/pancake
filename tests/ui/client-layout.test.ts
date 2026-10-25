import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { View } from 'react-native'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { chromium, webkit } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PlayerNameLine } from '@/components/player/PlayerNameLine'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { WebAppShell } from '@/components/navigation/WebTabShell'
import { themeVariablesCss } from '@/constants/tokens'
import { headerPlayer, playerRow } from '../helpers/fixtures'

vi.mock('react-native', async () => ({ ...await vi.importActual('react-native-web'), useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG', 'SG'] }))
vi.mock('@/components/Motion', () => ({ MotionView: View, MotionPressable: View }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))

vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({
    usePathname: () => '/players', useGlobalSearchParams: () => ({}), useRouter: () => ({ push: vi.fn(), dismissTo: vi.fn() }), Link: 'a', Navigator: 'div',
}))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => {
    const current = { id: 'member', team_name: 'Team', leagues: { id: 'league', name: 'OFFICIAL LEAGUE' } }
    return { current, currentLeague: current.leagues, memberships: [current], setCurrent: vi.fn(), membershipStatus: 'ready' }
} }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/hooks/use-pending-trade-count', () => ({ usePendingTradeCount: () => 0 }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: false, revision: 0 }) }))
vi.mock('@/hooks/use-boot-shell-handoff', () => ({ useBootShellHandoff: vi.fn() }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ draftLoading: false, draftChecked: true }) }))
vi.mock('@/lib/auth', () => ({ getProfile: vi.fn(), suspendProfileRead: vi.fn() }))
vi.mock('@/lib/profile-updates', () => ({ listenForProfileUpdates: vi.fn() }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: () => null }))

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks() })

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER)('keeps player tags and shell controls aligned at iPhone widths in both browser engines', async () => {
    const directory = process.env.PANCAKE_LAYOUT_OUTPUT ?? await mkdtemp(path.join(tmpdir(), 'pancake-client-layout-'))
    await mkdir(directory, { recursive: true })
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? { uri: `data:image/png;base64,${readFileSync('assets/images/pancake_logo.png').toString('base64')}` } : originalLoad.call(moduleLoader, name, ...args))
    const Fixture = () => React.createElement(WebAppShell, {}, React.createElement(PlayerEligibilityContext.Provider, { value: 2 },
        React.createElement(View, { style: { padding: 16, gap: 16 } },
            React.createElement(PlayerSearchItem, { item: playerRow({ display_name: 'An Extremely Long Player Name', injury_status: 'Day-To-Day', years_exp: 0 }), currentMemberId: 'member', ownedMap: new Map([['player-a', { memberId: 'member', teamName: 'My team' }]]), waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {}, animate: false }),
            ...['Out', 'DTD', 'IR'].map(injuryStatus => React.createElement(PlayerSearchItem, { key: injuryStatus, item: playerRow({ display_name: `${injuryStatus} Player With A Long Name`, injury_status: injuryStatus, years_exp: 0, avg_fantasy_points: 50.2, playing_now: injuryStatus === 'DTD' }), currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, showCompactStats: false, onAdd: () => {}, onPress: () => {}, animate: false })),
            ...['Short Name', 'An Extremely Long Player Name That Must Truncate'].map(name => React.createElement(PlayerNameLine, { key: name, name, injuryStatus: 'Day-To-Day', yearsExp: 0 })),
            React.createElement(PlayerHeader, { player: headerPlayer({ display_name: 'Stephen Curry', years_exp: 0, injury_status: 'Out', dynasty_rank: 12 }), rosterStatus: { status: 'free_agent' }, leagueActive: true, compact: true, action: { label: 'Add', onPress: () => {}, disabled: false, busy: false } }),
        )))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('ClientLayout', () => Fixture)
    const application = AppRegistry.getApplication('ClientLayout')
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeVariablesCss()}</style>${renderToStaticMarkup(application.getStyleElement())}</head><body style="margin:0">${renderToStaticMarkup(application.element)}</body></html>`
    await writeFile(`${directory}/index.html`, html)
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch()
        close = () => browser.close()
        for (const width of [320, 390, 430]) {
            const page = await browser.newPage({ viewport: { width, height: 844 } })
            await page.setContent(html)
            const geometry = await page.evaluate(() => {
                const rect = (element: Element) => element.getBoundingClientRect()
                const controls = ['[data-testid=pancake-brand]', '[aria-label="Switch league"]', '[aria-label="Open menu"]'].map(selector => rect(document.querySelector(selector)!))
                const lines = Array.from(document.querySelectorAll('[data-testid="player-name-line"]')).map(line => {
                    const name = line.firstElementChild!
                    const tags = Array.from(line.children).slice(1)
                    return { height: rect(line).height, nameHeight: rect(name).height, nameWidth: rect(name).width, tags: tags.map(tag => ({ top: rect(tag).top - rect(name).top, height: rect(tag).height, left: rect(tag).left, right: rect(tag).right })), nameRight: rect(name).right, right: rect(line).right }
                })
                const rows = Array.from(document.querySelectorAll('[aria-label^="Open "]')).filter(card => /Open (Out|DTD|IR) Player/.test(card.getAttribute('aria-label') ?? '')).map(card => {
                    const avatar = rect(Array.from(card.querySelectorAll('div')).find(element => getComputedStyle(element).borderTopLeftRadius === '18px')!)
                    const name = rect(card.querySelector('[data-testid="player-name-line"]')!.firstElementChild!)
                    const metadata = Array.from(card.querySelectorAll('*')).filter(element => element.childElementCount === 0 && /^(LAL|PG|SG|.* (FP|LIVE))$/.test(element.textContent ?? '')).map(element => {
                        const box = rect(element)
                        return { top: box.top, bottom: box.bottom }
                    })
                    const row = rect(card.parentElement!)
                    const add = card.parentElement!.querySelector('[aria-label^="Add "]')
                    return { metadata, label: card.getAttribute('aria-label'), avatar: { width: avatar.width, height: avatar.height, left: avatar.left, right: avatar.right, top: avatar.top, bottom: avatar.bottom }, name: { left: name.left, top: name.top, bottom: name.bottom }, rowHeight: row.height, center: row.top + row.height / 2, avatarCenter: avatar.top + avatar.height / 2, addCenter: add ? rect(add).top + rect(add).height / 2 : null }
                })
                const position = document.querySelector('[data-testid="player-position-line"]')!
                const summary = document.querySelector('[data-testid="player-summary-line"]')!
                return { rows, controls: controls.map(box => ({ top: box.top, height: box.height })), lines, summaryBelow: rect(summary).top >= rect(position).bottom, overflow: document.documentElement.scrollWidth > innerWidth }
            })
            expect(geometry.rows).toHaveLength(3)
            for (const row of geometry.rows) {
                expect(row.avatar.width).toBe(36)
                expect(row.avatar.height).toBe(36)
                expect(row.avatar.right, row.label ?? '').toBeLessThanOrEqual(row.name.left)
                expect(row.avatar.top, row.label ?? '').toBeLessThan(row.name.bottom)
                expect(row.avatar.bottom, row.label ?? '').toBeGreaterThan(row.name.top)
                expect(row.metadata).toHaveLength(4)
                expect(row.metadata.every(box => box.top >= row.name.bottom)).toBe(true)
                expect(Math.max(...row.metadata.map(box => box.top))).toBeLessThan(Math.min(...row.metadata.map(box => box.bottom)))
                expect(Math.abs(row.avatarCenter - row.center)).toBeLessThanOrEqual(1)
                if (row.addCenter !== null) {
                    expect(Math.abs(row.addCenter - row.center)).toBeLessThanOrEqual(1)
                    expect(row.rowHeight).toBeLessThanOrEqual(52)
                }
            }
            expect(geometry.controls.every(box => box.height === 44 && box.top === geometry.controls[0].top)).toBe(true)
            for (const line of geometry.lines) {
                expect(line.height).toBe(line.nameHeight)
                expect(line.nameWidth).toBeGreaterThan(28)
                expect(line.tags.every(tag => tag.height === line.nameHeight && tag.top === 0)).toBe(true)
                expect(line.tags[0].left).toBeGreaterThanOrEqual(line.nameRight)
                expect(line.tags.at(-1)!.right).toBeLessThanOrEqual(line.right)
            }
            expect(geometry.summaryBelow).toBe(true)
            expect(geometry.overflow).toBe(false)
            await page.screenshot({ path: `${directory}/${engine.name()}-${width}.png` })
            await page.close()
        }
        await browser.close()
        close = undefined
    }
}, 30000)
