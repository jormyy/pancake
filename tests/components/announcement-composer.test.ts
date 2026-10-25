import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { NotificationAnnouncementComposer } from '@/components/settings/NotificationAnnouncementComposer'

const publish = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' }, membershipValidated: true, isCommissioner: true }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'commissioner' } }) }))
vi.mock('@/lib/notification-preferences', () => ({ publishLeagueAnnouncement: publish }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('explains in-app delivery and optional commissioner push after publishing', async () => {
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(NotificationAnnouncementComposer)) })
        await act(async () => screen.root.findByType('TextInput' as React.ElementType).props.onChangeText('Draft tonight.'))
        await act(async () => screen.root.findByType('Pressable' as React.ElementType).props.onPress())
        expect(publish).toHaveBeenCalledWith('league', 'Draft tonight.', expect.any(String))
        const text = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).join(' ')
        expect(text).toContain('Members see this in the app.')
        expect(text).toContain('Only members who turned on Commissioner messages also get a push.')
    } finally { await act(async () => screen.unmount()) }
})
