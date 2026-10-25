import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HomeAnnouncementBanner } from '@/components/HomeAnnouncementBanner'
import type { LeagueAnnouncement } from '@/lib/league-announcements'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const announcements: LeagueAnnouncement[] = [
    { id: 'old', body: 'Welcome.', published_at: '2026-10-22T15:00:00Z', league_id: 'league', author_member_id: null },
    { id: 'new', body: 'Draft tonight.', published_at: '2026-10-23T15:00:00Z', league_id: 'league', author_member_id: 'commissioner' },
]
const props = { announcements, ownerId: 'user', memberId: 'member', leagueId: 'league', padX: 16 }
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).join(' ')
const dismiss = async () => act(async () => screen.root.findByProps({ accessibilityLabel: 'Dismiss announcement' }).props.onPress())
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T15:00:00Z')) })
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals(); vi.useRealTimers() })

it('shows the newest undismissed text and date, persists dismissal, and keeps it scoped to its member', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    expect(text()).toContain('Draft tonight.')
    expect(text()).toContain('Commissioner · Oct 23, 2026')
    await dismiss()
    expect(text()).not.toContain('Welcome.')
    await act(async () => screen.unmount())
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    expect(text()).not.toContain('Welcome.')
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
    expect(text()).not.toContain('Welcome.')
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
})

it('reserves no space when there is no announcement', async () => {
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, { ...props, announcements: [] })) })
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
})

it('skips the viewer posts and announcements older than fourteen days', async () => {
    const rows = [
        { ...announcements[1], id: 'own', author_member_id: 'member', published_at: '2026-10-24T15:00:00Z' },
        { ...announcements[0], id: 'expired', published_at: '2026-10-10T14:59:59Z' },
    ]
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, { ...props, announcements: rows })) })
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
})

it('uses the dismissed publish time across replacement IDs and keeps another league separate', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
    await act(async () => { screen = create(React.createElement(HomeAnnouncementBanner, props)) })
    await dismiss()
    await act(async () => screen.update(React.createElement(HomeAnnouncementBanner, { ...props, announcements: [{ ...announcements[1], id: 'replacement' }] })))
    expect(screen.root.findAllByType('View' as React.ElementType)).toHaveLength(0)
    await act(async () => screen.update(React.createElement(HomeAnnouncementBanner, { ...props, leagueId: 'other' })))
    expect(text()).toContain('Draft tonight.')
})
