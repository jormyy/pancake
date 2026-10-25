import '../helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { NotificationSettings } from '@/components/settings/NotificationSettings'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@/lib/notification-preferences'

vi.mock('@/components/settings/SettingsGroup', () => ({ SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle' }))

it('keeps player alerts without offering watched-player drop alerts', async () => {
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(NotificationSettings, { preferences: DEFAULT_NOTIFICATION_PREFERENCES, disabled: false, onChange: vi.fn() })) })
    const heading = screen.root.findAll(node => node.props.accessibilityLabel === 'Players events')[0]
    await act(async () => heading.props.onPress())
    const labels = screen.root.findAllByType('Pressable' as React.ElementType).map(node => node.props.accessibilityLabel)
    expect(labels.some(label => label?.startsWith('Players:'))).toBe(true)
    expect(labels.some(label => label?.includes('Watched player dropped'))).toBe(false)
    await act(async () => screen.unmount())
})
