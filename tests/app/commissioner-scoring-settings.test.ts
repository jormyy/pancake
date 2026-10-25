import React from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CommissionerSettingsScreen from '@/app/(modals)/commissioner-settings'
import { EMPTY_COMMISSIONER_SETTINGS_DRAFT } from '@/lib/commissioner-settings-draft'

const mocks = vi.hoisted(() => ({ controller: vi.fn(), updateScoring: vi.fn() }))

vi.mock('@/components/settings/NotificationAnnouncementComposer', () => ({ NotificationAnnouncementComposer: () => null }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null } }))
vi.mock('@/constants/tokens', () => ({ colors: {} }))
vi.mock('@/components/commissioner/settings-styles', () => ({ styles: {} }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: () => null }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/components/ui', () => ({ ErrorBanner: () => null, usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/hooks/use-commissioner-settings-controller', () => ({
    useCommissionerSettingsController: mocks.controller,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
    mocks.controller.mockReturnValue({
        draft: { ...EMPTY_COMMISSIONER_SETTINGS_DRAFT, scoring: { double_double: '1.5', triple_double: '3' } },
        authorityReady: true, hasDraft: true, loadState: 'ready', isCommissioner: true,
        lifecycle: { label: 'League setup', actions: [] }, members: [], lowerPriorityActions: [],
        updateScoring: mocks.updateScoring,
    })
})

describe('commissioner scoring bonus inputs', () => {
    it.each([
        ['Double-double', 'double_double', '1.5', '2.5'],
        ['Triple-double', 'triple_double', '3', '4'],
    ])('shows and edits the %s weight', async (label, key, value, changed) => {
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(CommissionerSettingsScreen)) })
        try {
            const input = renderer.root.findByProps({ accessibilityLabel: `${label} weight` })
            expect(input.props.value).toBe(value)
            await act(async () => { input.props.onChangeText(changed) })
            expect(mocks.updateScoring).toHaveBeenCalledWith(key, changed)
        } finally {
            await act(async () => { renderer.unmount() })
        }
    })
})
