import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamTimelineScreen } from '@/components/timeline/TeamTimelineScreen'
import { TimelineEntry } from '@/components/timeline/TimelineEntry'
import { timelineMatches, timelineRelativeTime, type TimelineEvent } from '@/lib/timeline'

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator',
}))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
const mocks = vi.hoisted(() => ({ state: { events: [] as TimelineEvent[], loading: false, loadingMore: false, hasMore: false,
    error: null as string | null, refresh: vi.fn(), loadMore: vi.fn(), retry: vi.fn() } }))
vi.mock('@/lib/timeline/useTeamTimeline', () => ({ useTeamTimeline: () => mocks.state }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const makeEvent = (id: string, kind: string, summary: string, reason: string | null): TimelineEvent => ({
    id, createdAt: new Date().toISOString(), kind, summary, reason, memberId: 'a', entityId: id, detail: {},
})
function content(renderer: ReactTestRenderer) { return renderer.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).flat().join(' ') }
beforeEach(() => {
    mocks.state.events = [makeEvent('1', 'claim.failed', 'Waiver claim failed', 'Bid tied; the other team has priority.'),
        makeEvent('2', 'trade.executed', 'Trade executed', 'Review window completed.'),
        makeEvent('3', 'lineup.auto_set', 'Lineup auto-set', null), makeEvent('4', 'scores.finalized', 'Matchup scores finalized', null)]
    mocks.state.error = null
    mocks.state.hasMore = false
    vi.clearAllMocks()
})
describe('timeline screen', () => {
    it('renders recorded reasons for claims and trades plus lineup and score outcomes', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TeamTimelineScreen, { leagueId: 'league', memberId: 'a' })) })
        for (const entry of mocks.state.events) {
            expect(content(renderer)).toContain(entry.summary)
            if (entry.reason) expect(content(renderer)).toContain(entry.reason)
        }
        expect(content(renderer)).toContain('Just now')
        await act(async () => { renderer.unmount() })
    })
    it('filters entries and retains the recorded reason text', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TeamTimelineScreen, { leagueId: 'league', memberId: 'a' })) })
        const button = renderer.root.findAllByType('Pressable' as React.ElementType).find(node => node.findAllByType('Text' as React.ElementType).some(text => text.props.children === 'Claims'))!
        await act(async () => { button.props.onPress() })
        expect(content(renderer)).toContain('Bid tied; the other team has priority.')
        expect(content(renderer)).not.toContain('Trade executed')
        await act(async () => { renderer.unmount() })
    })
    it('opens the exact claim or trade history from the entry button', async () => {
        const onOpen = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TimelineEntry, { memberId: 'a', entityId: 'claim', filter: 'claims', onOpen })) })
        await act(async () => { renderer.root.findByType('Pressable' as React.ElementType).props.onPress() })
        expect(onOpen).toHaveBeenCalledWith({ memberId: 'a', entityId: 'claim', filter: 'claims' })
        await act(async () => { renderer.unmount() })
    })
    it('retains paging access when the first page has no matching category', async () => {
        mocks.state.hasMore = true
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TeamTimelineScreen, { leagueId: 'league', memberId: 'a', entityId: 'older' })) })
        expect(content(renderer)).toContain('No matching activity on this page.')
        const button = renderer.root.findAllByType('Pressable' as React.ElementType).find(node => node.findAllByType('Text' as React.ElementType).some(text => text.props.children === 'Load older activity'))!
        await act(async () => { button.props.onPress() })
        expect(mocks.state.loadMore).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })
    it('keeps an offer and its counteroffer in one trade history', async () => {
        mocks.state.events = [
            { ...makeEvent('new', 'trade.executed', 'Trade executed', null), threadId: 'old' },
            { ...makeEvent('old', 'trade.sent', 'Trade offer sent', null), threadId: 'old' },
            { ...makeEvent('other', 'trade.executed', 'Unrelated trade', null), threadId: 'other' },
        ]
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TeamTimelineScreen, { leagueId: 'league', memberId: 'a', entityId: 'new', filter: 'trades' })) })
        expect(content(renderer)).toContain('Trade executed')
        expect(content(renderer)).toContain('Trade offer sent')
        expect(content(renderer)).not.toContain('Unrelated trade')
        await act(async () => { renderer.unmount() })
    })
    it('matches all requested categories and keeps picks and settings under All', () => {
        expect(mocks.state.events.map(event => timelineMatches(event, 'trades'))).toEqual([false, true, false, false])
        expect(timelineMatches(makeEvent('5', 'pick.made', '', null), 'all')).toBe(true)
        expect(timelineMatches(makeEvent('6', 'settings.changed', '', null), 'all')).toBe(true)
    })
    it('shows relative times across minute, hour and day boundaries', () => {
        const now = Date.parse('2026-10-27T12:00:00Z')
        expect(timelineRelativeTime('2026-10-27T11:58:00Z', now)).toBe('2m ago')
        expect(timelineRelativeTime('2026-10-27T10:00:00Z', now)).toBe('2h ago')
        expect(timelineRelativeTime('2026-10-25T12:00:00Z', now)).toBe('2d ago')
        expect(timelineRelativeTime('2026-10-27T13:00:00Z', now)).toBe('Just now')
    })
})
