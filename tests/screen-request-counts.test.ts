import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearScreenViews } from '@/lib/cache/screen-cache'
import { useScreenView } from '@/hooks/use-screen-view'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { usePlayerSearch } from '@/hooks/use-player-search'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import { useProfileResource } from '@/hooks/use-profile-resource'
import type { ScreenName } from '@/lib/cache/screen-cache'
const state = vi.hoisted(() => ({ requests: [] as string[], clears: [] as (() => void)[], userId: 'account' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: vi.fn() }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => state.userId, sessionGeneration: () => 0, onSessionCachesCleared: (callback: () => void) => state.clears.push(callback) }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:59621/functions/v1/api', apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: state.userId }, access_token: 'synthetic' } } }) }, from: () => { throw new Error('A screen issued a stitched table read') }, rpc: () => { throw new Error('A screen issued a stitched RPC') } } }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: true, revision: 0, isCurrent: () => true }) }))
vi.mock('@/lib/league-changes', () => ({ listenForLeagueChanges: () => () => {}, deferLeagueRefresh: () => ({ trigger() {}, cancel() {} }) }))
vi.mock('@/lib/rookieDraft', () => ({ subscribeToRookieDraft: () => ({}), unsubscribeFromRookieDraft: () => Promise.resolve(), processExpiredSnakePick: vi.fn(), makeSnakePick: vi.fn(), commissionerSnakePick: vi.fn(), activateRookieDraftLeague: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const context = { leagueId: 'league', memberId: 'member', seasonId: 'season', seasonYear: 2027, today: '2026-10-27', version: '1', weekNumber: 1 }
const payload = { context, draft: { id: 'draft', status: 'paused', leagueId: 'league', leagueSeasonId: 'season', isCurrentSeason: true }, orders: [], nextPick: null, prospects: [], matchup: null, selectedDate: '2026-10-27', weekDays: [], leagueMatchups: [], myLineup: null, oppLineup: null, liveStats: {}, teamMatchups: {}, startedTeams: [], todaysGames: [], announcements: [], forecast: null, roster: [], picks: [], claims: [], items: [], trades: [], hasMore: false, nextCursor: null, avgMap: {}, avgStatsMap: {}, ownedMap: {}, waiverClearsAt: {}, waiverIds: [], pendingClaimIds: [], players: [], visibleTotals: [], profile: null, preferences: {}, lines: [], availableSeasons: [2027], averages: null, player: { nba_team: null }, transactions: [], rows: [], standings: [], waiverOrder: [], rooms: [] }
beforeEach(() => {
    for (const clear of state.clears) clear()
    clearScreenViews(); state.requests = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        state.requests.push(url.pathname)
        return new Response(JSON.stringify(url.pathname.endsWith('/version') ? { version: '1', changes: [{ version: '1', topic: 'catchup', scope: {}, created_at: '' }] } : { ok: true, view: payload }))
    }))
})
const cases: [string, string, () => unknown][] = [
    ['home', 'home', () => useMatchupData({ id: 'member' }, { id: 'account' }, { id: 'league' })],
    ['players', 'players', () => usePlayerSearch('league', new Map(), new Set(), 'member', { ownerId: 'account' })],
    ['player', 'player', () => usePlayerScreenData('player', 'league', { ownerKey: JSON.stringify(['account', 'member']) })],
    ['trades offers', 'trades', () => useTradesFeed('member', 'league')],
    ['trades history', 'trades', () => useTradeHistoryFeed('member', 'league', true)],
    ['trade block', 'trade-block', () => useTradeBlock('member', 'league')],
    ...(['results', 'history', 'settings', 'picks', 'draft', 'auctions'] as const).map(tab => [`league ${tab}`, 'league', () => useLeagueTabResources('league', 'member', tab)] as [string, string, () => unknown]),
    ['profile', 'profile', () => useProfileResource('account')],
    ['rookie controller', 'draft-room', () => useRookieDraftRoomController({ draftId: 'draft', leagueId: 'league', memberId: 'member', rosterSize: 20 })],
    ...(['roster', 'lineup', 'claim-editor', 'draft-room', 'trade-details', 'trade-analysis', 'standings', 'activity', 'picks', 'settings', 'draft-rooms'] satisfies ScreenName[]).map(screen => [screen, screen, () => useScreenView({ accountId: 'account', leagueId: 'league', memberId: 'member', seasonId: 'season', screen })] as [string, string, () => unknown]),
]
describe('screen view request budgets', () => {
    it.each(cases)('%s opens with one view and one shared version check', async (name, screen, hook) => {
        let renderer!: ReactTestRenderer
        const Probe = () => { hook(); return null }
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => {})
        const reads = state.requests.filter(path => path.includes('/views/'))
        expect(reads, name).toEqual([`/functions/v1/api/views/${screen}`])
        expect(state.requests.filter(path => path.endsWith('/version'))).toHaveLength(screen === 'profile' ? 0 : 1)
        expect(state.requests).toHaveLength(screen === 'profile' ? 1 : 2)
        await act(async () => { renderer.unmount() })
    })
})
