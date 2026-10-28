import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { HomeAnnouncementBanner } from '@/components/HomeAnnouncementBanner'
import { TeamTimelineScreen } from '@/components/timeline/TeamTimelineScreen'
import { tradeCardModel } from '@/components/trades/TradeCard'
import { draftEventTime } from '@/lib/draft-display'
import { trade } from '@/tests/helpers/fixtures'
import type { LeagueProjectionRow } from '@/lib/projections'

const fixture = vi.hoisted(() => ({ timezone: 'America/Los_Angeles', instant: '2026-10-28T04:21:00Z' }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => fixture.timezone }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'View' }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'View' }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: 'View' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Pressable' }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: true, revision: 0 }) }))
vi.mock('@/lib/players', () => ({ getPlayerTransactionHistory: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/timeline/useTeamTimeline', () => ({ useTeamTimeline: () => ({ events: [{ id: 'event', createdAt: fixture.instant, kind: 'claim.failed', summary: 'Claim failed', reason: null, detail: {} }], loading: false, error: null, hasMore: false }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
async function render(element: React.ReactElement): Promise<string> {
    if (screen) await act(async () => screen!.unmount())
    await act(async () => { screen = create(element) })
    return screen!.root.findAllByType('Text' as React.ElementType).flatMap(node => [node.props.children].flat(8)).filter(value => typeof value === 'string' || typeof value === 'number').join(' ')
}
afterEach(async () => { if (screen) await act(async () => screen!.unmount()); screen = undefined; vi.useRealTimers() })

it.each([
    ['America/Los_Angeles', 'Oct 27, 2026, 9:21 PM PT', '9:21 PM PT'],
    ['Asia/Tokyo', 'Oct 28, 2026, 1:21 PM GMT+9', '1:21 PM GMT+9'],
])('renders game, history, announcement, timeline, trade and draft times in %s', async (timezone, dateTime, time) => {
    fixture.timezone = timezone
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T03:00:00Z'))
    const projection = { next_game_date: '2026-10-27', next_game_time: fixture.instant, next_game_opponent: 'vs BOS', projection_fantasy_points: 12 } as LeagueProjectionRow
    expect(await render(React.createElement(NextProjectionCard, { projection }))).toContain(time)
    expect(await render(React.createElement(TransactionHistory, { playerId: 'player', leagueId: 'league', transactions: [{ id: 'event', transactionType: 'waiver_add', label: 'Claimed', teamName: 'Team', occurredAt: fixture.instant }] }))).toContain(dateTime)
    expect(await render(React.createElement(HomeAnnouncementBanner, { announcements: [{ id: 'announcement', league_id: 'league', author_member_id: 'other', published_at: fixture.instant, body: 'Draft tonight' }], ownerId: 'owner', leagueId: 'league', padX: 16 }))).toContain(dateTime)
    expect(await render(React.createElement(TeamTimelineScreen, { leagueId: 'league', memberId: 'member', timezone }))).toContain(dateTime)
    for (const status of ['pending', 'accepted'] as const) {
        const model = tradeCardModel({ trade: trade({ status, expiresAt: fixture.instant, vetoWindowExpiresAt: fixture.instant }), myMemberId: 'member', tab: 'offers', timezone })
        expect(model.meta.join(' ')).toContain(dateTime)
    }
    expect(draftEventTime(fixture.instant, timezone)).toBe(time)
})
