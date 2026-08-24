import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function expectInOrder(source: string, labels: string[]) {
    const positions = labels.map((label) => source.indexOf(label))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

describe('primary navigation order', () => {
    it('keeps daily gameplay before analysis on web and native', async () => {
        const [nativeSource, webSource] = await Promise.all([
            readFile(path.join(ROOT, 'app/(tabs)/_layout.tsx'), 'utf8'),
            readFile(path.join(ROOT, 'components/navigation/WebTabShell.tsx'), 'utf8'),
        ])
        const labels = ['Matchup', 'Roster', 'Players', 'Trades', 'Dynasty', 'League']
        const webPrimary = webSource.slice(
            webSource.indexOf('const PRIMARY_NAV'),
            webSource.indexOf('const MOBILE_NAV'),
        )
        const webMobile = webSource.slice(
            webSource.indexOf('const MOBILE_NAV'),
            webSource.indexOf('const MOBILE_LABELS'),
        )

        expectInOrder(nativeSource, labels)
        expectInOrder(webPrimary, labels.slice(0, -1))
        expect(webMobile).toContain("{ label: 'League', href: '/league'")
        expect(nativeSource).not.toContain('NativeTabs.Trigger name="draft-room"')
        expect(nativeSource).not.toContain('NativeTabs.Trigger name="profile"')
    })

    it('keeps profile access in league settings', async () => {
        const [screenSource, panelSource] = await Promise.all([
            readFile(path.join(ROOT, 'app/(tabs)/league.tsx'), 'utf8'),
            readFile(path.join(ROOT, 'components/league/SettingsPanel.tsx'), 'utf8'),
        ])

        expect(screenSource).toContain('onOpenProfile={screen.openProfile}')
        expect(panelSource).toContain('accessibilityLabel="Open profile and settings"')
    })
})
