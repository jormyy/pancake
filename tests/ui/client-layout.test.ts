import { RookiePickRow } from '@/components/league/draft-room/RookiePickRow'
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
import { RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'
import { AssetList } from '@/components/trades/TradeCard'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { WebAppShell } from '@/components/navigation/WebTabShell'
import { themeVariablesCss, spacing } from '@/constants/tokens'
import { headerPlayer, playerRow, rosterPlayer } from '../helpers/fixtures'

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

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER).each(['players-case', 'roster-case', 'ir-case', 'taxi-case', 'trade-case', 'draft-case', 'desktop-case'])('keeps %s metadata aligned at iPhone widths', async caseId => {
    const directory = process.env.PANCAKE_LAYOUT_OUTPUT ?? await mkdtemp(path.join(tmpdir(), 'pancake-client-layout-'))
    await mkdir(directory, { recursive: true })
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? { uri: `data:image/png;base64,${readFileSync('assets/images/pancake_logo.png').toString('base64')}` } : originalLoad.call(moduleLoader, name, ...args))
    const name = 'A Very Long Player Name That Must Truncate'
    const player = playerRow({ display_name: name, injury_status: 'Out', years_exp: 0, avg_fantasy_points: 50.2 })
    const roster = rosterPlayer({ players: { ...rosterPlayer().players, ...player } })
    const Fixture = () => React.createElement(WebAppShell, {}, React.createElement(PlayerEligibilityContext.Provider, { value: 2 },
        React.createElement(View, { style: { padding: 8, gap: 16 } },
            React.createElement(View, { testID: 'players-case' }, React.createElement(PlayerSearchItem, { item: player, currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, showStats: caseId === 'desktop-case', showCompactStats: true, onAdd: () => {}, onPress: () => {}, animate: false })),
            React.createElement(View, { testID: 'roster-case' }, React.createElement(RosterPlayerItem, { item: roster, slotType: 'PG', togglingId: null, taxiingId: null, droppingId: null, avgFpts: 50.2, avgMinutes: 32, onPress: () => {}, onLongPress: () => {}, onToggleIR: () => {}, allowIR: true })),
            React.createElement(View, { testID: 'ir-case' }, React.createElement(RosterPlayerItem, { item: { ...roster, is_on_ir: true }, slotType: 'IR', togglingId: null, taxiingId: null, droppingId: null, avgFpts: 50.2, avgMinutes: 32, onPress: () => {}, onLongPress: () => {}, onToggleIR: () => {} })),
            React.createElement(View, { testID: 'taxi-case' }, React.createElement(TaxiPlayerItem, { item: { ...roster, is_on_taxi: true }, taxiingId: null, avgFpts: 50.2, avgMinutes: 32, onPress: () => {}, onToggleTaxi: () => {} })),
            React.createElement(View, { testID: 'trade-case' }, React.createElement(AssetList, { label: 'Assets', items: [{ kind: 'player', playerId: player.id, playerName: name, nbaTeam: 'LAL', position: 'PG', eligiblePositions: ['PG', 'SG'], yearsExp: 0, injuryStatus: 'Out', avgFantasyPoints: 50.2, avgMinutesPlayed: 32 }] })),
            React.createElement(View, { testID: 'draft-case' }, React.createElement(RookiePickRow, { item: { overallPick: 1, round: 1, pickInRound: 1, memberId: 'member', teamName: 'A long team name', pickedAt: null, skippedAt: null, skipReason: null, timerExpiresAt: null, player: { id: player.id, displayName: name, nbaId: null, nbaTeam: 'LAL', position: 'PG', yearsExp: 0, careerGames: 0, injuryStatus: 'Out' } }, nextPick: null })),
            React.createElement(PlayerHeader, { player: headerPlayer({ display_name: 'Stephen Curry', years_exp: 0, injury_status: 'Out', dynasty_rank: 12 }), rosterStatus: { status: 'free_agent' }, leagueActive: true, compact: true }),
        )))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('ClientLayout', () => Fixture)
    const application = AppRegistry.getApplication('ClientLayout')
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeVariablesCss()}</style>${renderToStaticMarkup(application.getStyleElement())}</head><body style="margin:0">${renderToStaticMarkup(application.element)}</body></html>`
    await writeFile(`${directory}/index.html`, html)
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch()
        close = () => browser.close()
        for (const width of caseId === 'desktop-case' ? [1024] : [320, 390, 430]) {
            const page = await browser.newPage({ viewport: { width, height: 844 } })
            await page.setContent(html)
            {
                const id = caseId === 'desktop-case' ? 'players-case' : caseId
                expect(await page.getByTestId(id).getByTestId('player-meta-line').count()).toBe(1)
                expect(await page.getByTestId(id).getByTestId('player-stats-line').count()).toBe(caseId === 'draft-case' ? 0 : 1)
                const geometry = await page.getByTestId(id).evaluate(root => {
                    const box = (node: Element) => {
                        const rect = node.getBoundingClientRect()
                        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height }
                    }
                    const name = root.querySelector('[data-testid="player-name-line"]')!
                    const meta = root.querySelector('[data-testid="player-meta-line"]')!
                    const stats = root.querySelector('[data-testid="player-stats-line"]')!
                    const avatar = root.querySelector('[data-testid="player-row-avatar"]')!
                    const team = meta.firstElementChild!
                    const teamClipped = team.scrollWidth > team.clientWidth
                    const tags = Array.from(meta.querySelectorAll('[aria-label]')).map(tag => ({ label: tag.getAttribute('aria-label'), text: tag.textContent, ...box(tag) }))
                    const positions = Array.from(meta.querySelectorAll('[data-testid="position-chip"]')).map(box)
                    const row = root.querySelector('[data-testid="player-row-content"]')!
                    const action = root.querySelector('[aria-label^="Add "], [aria-label^="Move "], [aria-label^="Activate "]')
                    return { team: box(team), teamClipped, action: action ? box(action) : null, name: box(name), meta: box(meta), stats: stats ? box(stats) : null, avatar: box(avatar), row: box(row), tags, positions, overflow: document.documentElement.scrollWidth > innerWidth, text: name.textContent }
                })
                expect(geometry.text).toBe(name)
                expect(geometry.teamClipped).toBe(false)
                expect(geometry.name.bottom).toBeLessThanOrEqual(geometry.meta.top)
                if (geometry.stats) {
                    expect(geometry.meta.bottom).toBeLessThanOrEqual(geometry.stats.top)
                    expect(geometry.stats.height).toBeLessThanOrEqual(18)
                }
                expect(geometry.avatar.right).toBeLessThanOrEqual(geometry.name.left)
                expect(Math.abs((geometry.avatar.top + geometry.avatar.bottom) / 2 - (geometry.row.top + geometry.row.bottom) / 2)).toBeLessThanOrEqual(1)
                if (geometry.action) expect(Math.abs((geometry.action.top + geometry.action.bottom) / 2 - (geometry.row.top + geometry.row.bottom) / 2)).toBeLessThanOrEqual(1)
                expect(geometry.tags.map(tag => [tag.text, tag.label])).toEqual([['O', 'Out'], ['R', 'Rookie'], [caseId === 'draft-case' ? 'T:0' : 'T:—', caseId === 'draft-case' ? 'Taxi eligible, 0 career regular-season games' : 'Taxi eligible, career games unknown']])
                expect(geometry.positions).toHaveLength(caseId === 'draft-case' ? 1 : 2)
                expect(geometry.positions[0].left - geometry.team.right).toBeCloseTo(spacing.xxs)
                expect(geometry.tags[0].left).toBeGreaterThanOrEqual(geometry.positions.at(-1)!.right)
                expect(geometry.tags.every(tag => tag.height === geometry.positions[0].height)).toBe(true)
                expect(geometry.row.right).toBeLessThanOrEqual(width)
                expect(geometry.overflow).toBe(false)
            }
            const headerGap = await page.getByTestId('player-position-line').evaluate(line => {
                const team = line.firstElementChild!.getBoundingClientRect()
                const position = line.querySelector('[data-testid="position-chip"]')!.getBoundingClientRect()
                return position.left - team.right
            })
            expect(headerGap).toBeCloseTo(spacing.xs)
            await page.screenshot({ path: `${directory}/${caseId}-${engine.name()}-${width}.png` })
            await page.close()
        }
        await browser.close()
        close = undefined
    }
}, 30000)
