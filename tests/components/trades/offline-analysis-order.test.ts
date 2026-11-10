import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trade, TradePickItem } from '@/lib/trades'
import { trade } from '../../helpers/fixtures'
import { analyzeDynastyTrade } from '@/core/src/dynasty/tradeScoring'
import TradeAnalyzer from '@/components/trades/TradeAnalyzer'

const saved = vi.hoisted(() => new Map<string, unknown>())
const request = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ online: true }))
const composer = vi.hoisted(() => ({
    participantIds: ['me', 'them'], participantRosters: {}, participantViews: [] as { memberId: string; picks: TradePickItem[] }[], assetsReady: true, selectedAssetsAvailable: false,
    selectedParticipantIds: new Set(), buildMultiTeamItems: () => state.online ? [{ kind: 'pick', pickId: 'r2-2030', fromMemberId: 'me', toMemberId: 'them' }] : [], reset: () => {},
    setParticipantIds: () => {}, prefillFromTrade: () => {}, participantName: () => 'My team',
}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value }, ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable', Text: 'Text', View: 'View', ScrollView: 'ScrollView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/ui/Page', () => ({ usePageMetrics: () => ({ usableWidth: 402 }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: 'MultiTeamTradeBuilder' }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: ({ name }: { name: string }) => React.createElement('Text', {}, name) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'me', team_name: 'My team' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => state.online }))
vi.mock('@/hooks/use-multi-team-trade-composer', () => ({ useMultiTeamTradeComposer: () => composer }))
vi.mock('@/lib/shared/api', () => ({ apiPost: request }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/contexts/panel-activity', () => ({ usePanelActivity: () => true }))
vi.mock('@/lib/league-changes', () => ({ deferLeagueRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), listenForLeagueChanges: () => () => {} }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: vi.fn(async () => [{ id: 'them', team_name: 'Their team' }]), isTradingClosed: () => false }))
vi.mock('@/lib/dynasty-decisions', () => ({
    dynastyAnalyzerLatestScopeCacheKey: () => 'scope', dynastyAnalyzerLatestRouteCacheKey: () => 'route',
    dynastyAnalyzerSnapshotCacheKey: () => 'snapshot', dynastyAnalyzerRouteSignature: (items: unknown[]) => items.length ? 'selected-route' : '', dynastyScoringSignature: () => '',
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: (key: string) => saved.get(key) ?? null,
    writePersistentCache: (key: string, value: unknown) => saved.set(key, JSON.parse(JSON.stringify(value))),
}))
vi.mock('@/lib/trade-analyzer-session', () => ({ saveTradeAnalyzerDraft: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true


let renderer: ReturnType<typeof create> | undefined
beforeEach(() => { saved.clear(); state.online = true; composer.assetsReady = true; vi.useFakeTimers(); request.mockReset() })
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.useRealTimers() })

it.each(['composer', 'historical'] as const)('orders metadata-free server assets from %s picks and saves the result', async source => {
    const picks = [
        { kind: 'pick', id: 'r2-2030', label: '2030 Round 2', round: 2, seasonYear: 2030, teams: 10 },
        { kind: 'pick', id: 'r1-2031', label: '2031 Round 1', round: 1, seasonYear: 2031, teams: 10 },
        { kind: 'pick', id: 'r1-2029', label: '2029 Round 1', round: 1, seasonYear: 2029, teams: 10 },
    ] as const
    const analysis = analyzeDynastyTrade({ leagueId: 'league', seasonYear: 2027, scoringSettings: {} }, 'overall', picks.map(asset => ({
        fromMemberId: 'me', toMemberId: 'them', asset: { ...asset, slot: null, valueBands: { early: 500, mid: 400, late: 300 } },
    })))
    expect(analysis.assets.every(asset => !('round' in asset) && !('seasonYear' in asset))).toBe(true)
    const metadata: TradePickItem[] = picks.map(pick => ({ kind: 'pick', pickId: pick.id, round: pick.round, seasonYear: pick.seasonYear, originalTeamName: 'My team' }))
    composer.participantViews = [{ memberId: 'me', picks: source === 'composer' ? metadata : [] }, { memberId: 'them', picks: [] }]
    const prefillTrade: Trade | undefined = source === 'historical' ? trade({ id: 'history', routedItems: metadata.map(pick => ({ ...pick, fromMemberId: 'me', toMemberId: 'them' })) }) : undefined
    const value = { id: 'quote', analysis, seasonYear: 2027, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }
    request.mockResolvedValue(source === 'historical' ? { revaluation: { ...value, tradeId: 'history' } } : { quote: value })
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer, { prefillTrade })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    if (source === 'composer') await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.onPress())
    const labels = () => renderer!.root.findAllByType('Text' as React.ElementType).flatMap(node =>
        typeof node.props.children === 'string' && /Round/.test(node.props.children) ? [node.props.children] : [])
    expect(labels()).toEqual(['2029 Round 1', '2031 Round 1', '2030 Round 2'])
    const snapshot = saved.get('snapshot') as { analysis: typeof analysis }
    expect(snapshot.analysis.assets).toEqual(analysis.assets.map((asset, index) => ({ ...asset, round: picks[index].round, seasonYear: picks[index].seasonYear })))
    expect(snapshot.analysis.teams).toEqual(analysis.teams)
    expect(analysis.assets.every(asset => !('round' in asset) && !('seasonYear' in asset))).toBe(true)
    expect(request.mock.calls[0][0]).toBe(source === 'historical' ? '/trades/history/revalue' : '/trades/estimate')
    if (source === 'historical') return
    await act(async () => renderer!.unmount())
    state.online = false
    composer.participantViews = []
    composer.assetsReady = false
    request.mockClear()
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.onPress())
    expect(labels()).toEqual(['2029 Round 1', '2031 Round 1', '2030 Round 2'])
    expect(saved.get('snapshot')).toEqual(snapshot)
    expect(request).not.toHaveBeenCalled()
})

it('orders an old saved result offline without fetching or rewriting its values', async () => {
    const routes = [
        { kind: 'pick', id: 'second', label: '2030 Round 2 · My team', round: 2, seasonYear: 2030, teams: 10, slot: null, valueBands: { early: 500, mid: 400, late: 300 } },
        { kind: 'player', id: 'missing', label: 'A missing' },
        { kind: 'player', id: 'low', label: 'Low', tradeValue: 100 },
        { kind: 'player', id: 'tie-b', label: 'Tie', tradeValue: 800 },
        { kind: 'player', id: 'high', label: 'High', tradeValue: 900 },
        { kind: 'player', id: 'tie-a', label: 'Tie', tradeValue: 800 },
        { kind: 'player', id: 'zero', label: 'Zero', tradeValue: 0 },
        { kind: 'pick', id: 'first', label: '2031 Round 1 · My team', round: 1, seasonYear: 2031, teams: 10, slot: null, valueBands: { early: 500, mid: 400, late: 300 } },
    ] as const
    const analysis = analyzeDynastyTrade({ leagueId: 'league', seasonYear: 2027, scoringSettings: {} }, 'overall',
        routes.map(asset => ({ fromMemberId: 'me', toMemberId: 'them', asset: asset.kind === 'player'
            ? { age: null, dynastyRank: null, rankMovement: null, healthStatus: null, ...asset } : asset })))
    const snapshot = { modelVersion: 'onenumber-trade-curve-v6', analysis, leagueId: 'league', memberId: 'me', participantNames: { me: 'My team', them: 'Their team' }, savedAt: '2026-01-01' }
    saved.set('scope', {})
    saved.set('route', 'old-selection')
    saved.set('snapshot', structuredClone(snapshot))
    state.online = false
    composer.assetsReady = false
    composer.participantViews = []
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.onPress())
    const labels = renderer!.root.findAllByType('Text' as React.ElementType).flatMap(node =>
        typeof node.props.children === 'string' && routes.some(asset => asset.label === node.props.children) ? [node.props.children] : [])
    expect(labels).toEqual(['High', 'Tie', 'Tie', 'Low', 'Zero', 'A missing', '2031 Round 1 · My team', '2030 Round 2 · My team'])
    expect(saved.get('snapshot')).toEqual(snapshot)
    expect(request).not.toHaveBeenCalled()
})
