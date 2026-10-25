import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { HomeAnnouncementBanner } from '@/components/HomeAnnouncementBanner'
import type { LeagueAnnouncement } from '@/lib/league-announcements'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const announcements: LeagueAnnouncement[] = [
    { id: 'old', body: 'Welcome.', published_at: '2026-10-22T15:00:00Z', league_id: 'league', author_member_id: null },
    { id: 'new', body: 'Draft tonight.', published_at: '2026-10-23T15:00:00Z', league_id: 'league', author_member_id: 'commissioner' },
]
const props = { announcements, ownerId: 'member', leagueId: 'league', padX: 16 }
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).join(' ')
const dismiss = async () => act(async () => screen.root.findByProps({ accessibilityLabel: 'Dismiss announcement' }).props.onPress())
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })

it('shows the newest undismissed text and date, persists dismissal, and keeps it scoped to its member', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    expect(text()).toContain('Draft tonight.')
    expect(text()).toContain('Commissioner · Oct 23, 2026')
    await dismiss()
    expect(text()).toContain('Welcome.')
    await act(async () => screen.unmount())
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    expect(text()).toContain('Welcome.')
    await act(async () => screen.update(React.createElement(HomeAnnouncementBanner, { ...props, ownerId: 'other' })))
    expect(text()).toContain('Draft tonight.')
})

it.each(['missing', 'read', 'write'])('renders and dismisses with %s storage failure', async failure => {
    vi.stubGlobal('window', failure === 'missing' ? undefined : { localStorage: {
        getItem: () => { if (failure === 'read') throw new Error('Storage blocked'); return null },
        setItem: () => { throw new Error('Storage blocked') },
    } })
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    expect(text()).toContain('Draft tonight.')
    await dismiss()
    expect(text()).toContain('Welcome.')
    await dismiss()
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
})

it('reserves no space when there is no announcement', async () => {
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, { ...props, announcements: [] })) })
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
})
