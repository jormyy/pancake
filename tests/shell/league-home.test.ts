import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { LeagueHome, LEAGUE_LINKS } from '@/components/navigation/LeagueHome'

const state = vi.hoisted(() => ({ commissioner: false, push: vi.fn() }))
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', Text: 'Text', View: 'View', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { name: 'Test League' }, isCommissioner: state.commissioner }) }))
vi.mock('@/components/ui', () => ({ Page: 'Page', PageHeader: 'PageHeader' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()); vi.clearAllMocks() })

it.each([false, true])('exposes each League entry with commissioner=%s', async commissioner => {
    state.commissioner = commissioner
    await act(async () => { screen = create(React.createElement(LeagueHome)) })
    for (const section of LEAGUE_LINKS) {
        for (const link of section.links) {
            const button = screen.root.findByProps({ accessibilityLabel: link.label })
            await act(async () => button.props.onPress())
            expect(state.push).toHaveBeenLastCalledWith(link.href)
        }
    }
    const controls = screen.root.findAllByProps({ title: 'Commissioner' })
    expect(controls).toHaveLength(commissioner ? 1 : 0)
    if (commissioner) {
        await act(async () => controls[0].props.onPress())
        expect(state.push).toHaveBeenLastCalledWith('/(modals)/commissioner-settings')
    }
})
