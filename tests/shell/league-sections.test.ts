import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { hasShellBackHeader } from '@/constants/navigation'
import { LEAGUE_TABS, parseLeagueTab } from '@/lib/league/tabs'

it('opens Standings by default and keeps league sections one tap away', () => {
    expect(parseLeagueTab(undefined)).toBe('results')
    expect(LEAGUE_TABS.map(tab => tab.label)).toEqual(['Standings', 'Activity', 'Picks', 'Schedule', 'Draft', 'Bracket', 'Settings'])
    const source = readFileSync('app/(tabs)/league.tsx', 'utf8')
    expect(source).not.toContain('<LeagueHome')
    expect(source).not.toContain('currentLeague?.name')
    expect(source).toContain('scrollable')
    expect(source).not.toContain('onBack=')
})

it('keeps account and administration links directly in the menu', () => {
    const source = readFileSync('components/navigation/WebTabShell.tsx', 'utf8').split('function MobileMenuSheet')[1].split('export function WebAppShell')[0]
    for (const label of ['League settings', 'Commissioner tools', 'Invite link', 'Notification settings', 'Profile']) expect(source).toContain(`label: '${label}'`)
    for (const label of ['Roster', 'Lineup', 'Waivers', 'Trades']) expect(source).not.toContain(`label: '${label}'`)
    const glyphs = JSON.parse(readFileSync('assets/fonts/MaterialIcons.glyphs.json', 'utf8'))
    for (const [, icon] of source.matchAll(/icon: '([^']+)'/g)) expect(glyphs[icon], icon).toBeDefined()
})

it('uses the same horizontal section control as Trades', () => {
    for (const file of ['app/(tabs)/league.tsx', 'app/(tabs)/trades.tsx']) {
        expect(readFileSync(file, 'utf8')).toMatch(/<SegmentedControl\s+variant="tabs"\s+scrollable/)
    }
})

it('keeps the app header above the playoff bracket', () => {
    expect(hasShellBackHeader('/bracket')).toBe(false)
})
