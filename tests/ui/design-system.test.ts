import { designSystemViolations, scanDesignSystem } from '../../scripts/check-design-system.mjs'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { componentTokens, controlSize } from '@/constants/tokens'
import { PageHeader } from '@/components/ui/Page'
import { PlayerRow } from '@/components/ui/PlayerRow'
import { Badge } from '@/components/ui/Badge'
import { SectionBand } from '@/components/ui/SectionBand'
import { ListHeader } from '@/components/ui/ListHeader'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Sheet } from '@/components/ui/Sheet'
import { StatCell } from '@/components/ui/StatCell'

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView', Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/player/PlayerAvatar', () => ({ PlayerAvatar: 'Avatar' }))
vi.mock('@/components/player/PlayerEligibilityTags', () => ({ PlayerEligibilityTags: () => null }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
const render = async (element: React.ReactElement) => { await act(async () => { screen = create(element) }); return screen }
afterEach(async () => { await act(async () => screen?.unmount()); vi.doUnmock('@/constants/tokens') })

it('preserves the shipped phone and lineup measurements', async () => {
    await render(React.createElement(PageHeader, { compact: true, title: 'Lineup', onBack: vi.fn(), backLabel: 'Close lineup' }))
    expect(screen.toJSON()).toBeNull()
    expect(controlSize.field.fontSize).toBe(16)
    expect(componentTokens.playerRow.compact.avatarSize).toBe(28)
    expect(componentTokens.playerRow.standard.avatarSize).toBe(32)
    expect(componentTokens.playerRow.name.fontSize).toBe(13)
    expect(componentTokens.playerRow.metadata.fontSize).toBe(12)
})

it.each([false, true])('keeps full player names and metadata at compact=%s', async compact => {
    await render(React.createElement(PlayerRow, { name: 'A Very Long Player Name That Must Remain Visible', team: 'LAL', compact }))
    const name = screen.root.findByProps({ testID: 'player-name-line' })
    expect(name.props.numberOfLines).toBeUndefined()
    expect(name.props.children).toBe('A Very Long Player Name That Must Remain Visible')
    expect(screen.root.findByType('Avatar' as React.ElementType).props.size).toBe(compact ? 28 : 32)
    expect(flatten(screen.root.findByProps({ testID: 'player-meta-line' }).props.style).flexWrap).toBe('wrap')
})

it('keeps action bands and sortable headers at the minimum target size', async () => {
    await render(React.createElement(React.Fragment, null,
        React.createElement(SectionBand, { label: 'Starters', variant: 'action', detail: 'Auto-set' }),
        React.createElement(ListHeader, { interactive: true }, 'Sort by points'),
    ))
    const rows = screen.root.findAllByType('View' as React.ElementType)
    expect(flatten(rows[0].props.style).minHeight).toBeGreaterThanOrEqual(44)
    expect(flatten(rows[2].props.style).minHeight).toBeGreaterThanOrEqual(44)
    expect(rows[0].props.accessibilityLabel).toBe('Starters')
})

it('retains badge labels and allows enlarged text to increase its height', async () => {
    await render(React.createElement(Badge, { label: 'DTD', accessibilityLabel: 'Day-To-Day', inline: true }))
    const badge = screen.root.findByType('View' as React.ElementType)
    expect(badge.props.accessibilityLabel).toBe('Day-To-Day')
    expect(flatten(badge.props.style).height).toBeUndefined()
    expect(flatten(badge.props.style).minHeight).toBe(16)
})

it.each([[null, false, '—'], [0, false, '0.0'], [12.6, true, '13']])('formats %s with integer=%s as %s', async (value, integer, expected) => {
    await render(React.createElement(StatCell, { value, integer }))
    expect(screen.root.findByType('Text' as React.ElementType).props.children).toBe(expected)
})

it('keeps tab names, counts, and keyboard selection', async () => {
    const onChange = vi.fn()
    await render(React.createElement(SegmentedControl, {
        options: [{ label: 'Standings', value: 'standings' }, { label: 'Activity', value: 'activity', badge: 12 }],
        value: 'standings', onChange, variant: 'tabs', accessibilityLabel: 'League sections',
    }))
    const tabs = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual(['Standings', 'Activity, 12'])
    expect(tabs.map(tab => tab.props.tabIndex)).toEqual([0, -1])
    const preventDefault = vi.fn()
    await act(async () => tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault }))
    expect(onChange).toHaveBeenCalledWith('activity')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(screen.root.findByType(Badge).props.size).toBe('count')
})

it('keeps sheet titles and close controls accessible', async () => {
    const onClose = vi.fn()
    // eslint-disable-next-line react/no-children-prop
    await render(React.createElement(Sheet, { visible: true, title: 'Auto-set lineup', onClose, children: 'Choose dates' }))
    const close = screen.root.findAllByType('Pressable' as React.ElementType).find(node => node.props.accessibilityRole === 'button')!
    expect(close.props.accessibilityLabel).toBe('Close')
    expect(flatten(close.props.style)).toMatchObject({ width: 44, height: 44 })
    await act(async () => close.props.onPress())
    expect(onClose).toHaveBeenCalledOnce()
    const title = screen.root.findByType('Text' as React.ElementType)
    expect(title.props.children).toBe('Auto-set lineup')
    expect(title.props.numberOfLines).toBeUndefined()
    expect(screen.root.findByType('Modal' as React.ElementType).props['aria-labelledby']).toBe(title.props.nativeID)
})

it('moves every title header after one base header token edit', async () => {
    vi.resetModules()
    const original = readFileSync('constants/tokens.ts', 'utf8')
    const edited = original.replace('pageHeaderHeight: unit(14)', 'pageHeaderHeight: unit(16)')
    expect(edited).not.toBe(original)
    const output = transpileModule(edited, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
    const module = { exports: {} }
    runInNewContext(output, { module, exports: module.exports, require: () => ({ Platform: { OS: 'web' } }) })
    vi.doMock('@/constants/tokens', () => module.exports)
    const source = await import('@/constants/tokens')
    const { PageHeader: ChangedHeader } = await import('@/components/ui/Page')
    await render(React.createElement(React.Fragment, null,
        React.createElement(ChangedHeader, { title: 'Roster' }),
        React.createElement(ChangedHeader, { title: 'League' }),
        React.createElement(ChangedHeader, { title: 'Lineup', compact: true }),
    ))
    const heights = screen.root.findAllByType('View' as React.ElementType)
        .filter(node => flatten(node.props.style).borderBottomWidth === 1)
        .map(node => flatten(node.props.style).minHeight)
    expect(source.layout.pageHeaderHeight).toBe(64)
    expect(heights).toEqual([64, 64, 57])
})

it.each(['Trade analysis', 'Propose trade', 'Claim player', 'Lineup', 'Team roster', 'Bracket', 'Draft', 'Settings'])('omits the web title row for %s', async title => {
    await render(React.createElement(PageHeader, { title, onBack: () => {} }))
    expect(screen.toJSON()).toBeNull()
})

it('keeps modal actions while removing the title and back button', async () => {
    await render(React.createElement(PageHeader, { title: 'Settings', onBack: () => {}, actions: React.createElement('Action') }))
    expect(screen.root.findAllByType('Action' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByType('Text' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findAllByType('Pressable' as React.ElementType)).toHaveLength(0)
})

it('requires shared design tokens throughout app and feature components', () => {
    expect(designSystemViolations()).toEqual([])
})
it.each([
    'const style = { color: "#ff0000" }',
    'const style = { backgroundColor: "rgba(0,0,0,0.5)" }',
    'const style = { color: "white" }',
    'const style = { fontSize: 16 }',
    'const style = { fontSize: \"16px\" }',
    'const shade = \"rebeccapurple\"; const style = { color: shade }',
    'const style = { [\"padding\"]: 16 }',
    'const style = { padding: 2 * 8 }',
    'const style = { color: `rgba(255,0,0,${opacity})` }',
    'const style = { borderTopLeftRadius: 8 }',
    'const style = { padding: 0, marginTop: 12, gap: 4 }',
    'const gap = 12; const style = { columnGap: gap }',
    'const style = { paddingBottom: inset + 16 }',
    'const style = { fontSize: compact ? 12 : 16 }',
    '<Text fontSize={16} />',
    'const css = `padding: 12px 8px; border-radius: 4px; font-size: 16px`',
])('rejects a raw design literal: %s', source => {
    expect(scanDesignSystem(source, 'components/Fixture.tsx').length).toBeGreaterThan(0)
})
it('accepts shared tokens, runtime sizes and structural numbers', () => {
    expect(scanDesignSystem('const style = { padding: spacing.md, margin: spacing.lg * 2, fontSize: fontSize.lg, borderRadius: radii.md, color: colors.primary, flex: 1, opacity: 0.5, top: insets.top }')).toEqual([])
    expect(scanDesignSystem('const styles = { left: { flex: 1, minWidth: 0 }, right: { flex: 1 } }')).toEqual([])
    expect(scanDesignSystem('const style = { padding: 16 }', 'components/ui/Fixture.tsx')).toEqual([])
    expect(scanDesignSystem('const style = { padding: 16 }', 'constants/tokens.ts')).toEqual([])
})
