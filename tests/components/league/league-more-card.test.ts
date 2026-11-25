import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { LeagueMoreCard } from '@/components/league/LeagueMoreCard'

vi.mock('react-native', () => ({
    Pressable: 'Pressable', Text: 'Text', Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/ui/Card', () => ({ Card: 'Card' }))
vi.mock('@/components/ui/SectionBand', () => ({ SectionBand: 'SectionBand' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('lists every League view outside the primary sections and opens the chosen one', async () => {
    const onSelect = vi.fn()
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(LeagueMoreCard, { onSelect, activeTab: 'picks' })) })
    try {
        expect(screen.root.findByType('SectionBand' as React.ElementType).props.label).toBe('More')
        const rows = screen.root.findAllByType('Pressable' as React.ElementType)
        expect(rows.map(row => row.props.accessibilityLabel)).toEqual(['Activity', 'Picks', 'History', 'Draft', 'Settings'])
        expect(rows.every(row => row.props.accessibilityRole === 'button')).toBe(true)
        await act(async () => rows[3].props.onPress())
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('draft')
    } finally {
        await act(async () => screen.unmount())
    }
})
