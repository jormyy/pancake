import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { DynastyTradeAnalysis } from '@/core/src/dynasty/decisionEngine'
import { analyzeDynastyTrade } from '@/core/src/dynasty/tradeScoring'
import TradeAnalyzer from '@/components/trades/TradeAnalyzer'

const saved = vi.hoisted(() => ({ value: null as unknown }))
const state = vi.hoisted(() => ({ online: false, modelVersion: 'onenumber-trade-curve-v6', loading: false, analysis: null as unknown, retry: vi.fn() }))
const composer = vi.hoisted(() => ({
    participantIds: ['me'], participantRosters: {}, participantViews: [] as { memberId: string }[], assetsReady: false, selectedAssetsAvailable: false,
    selectedParticipantIds: new Set(), buildMultiTeamItems: () => [], reset: () => {},
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
vi.mock('@/hooks/use-dynasty-trade-analysis', () => ({ useDynastyTradeAnalysis: () => ({ analysis: state.analysis, seasonYear: null, loading: state.loading, error: null, retry: state.retry }) }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: vi.fn(async () => []), isTradingClosed: () => false }))
vi.mock('@/lib/dynasty-decisions', () => ({
    dynastyAnalyzerLatestScopeCacheKey: () => 'scope', dynastyAnalyzerLatestRouteCacheKey: () => 'route',
    dynastyAnalyzerSnapshotCacheKey: () => 'snapshot', dynastyAnalyzerRouteSignature: () => '', dynastyScoringSignature: () => '',
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: (key: string) => key === 'scope' ? { seasonYear: 2027 } : key === 'route' ? 'saved-route'
        : key === 'snapshot' ? { modelVersion: state.modelVersion, analysis: saved.value, leagueId: 'league', memberId: 'me', participantNames: { me: 'My team' } } : null,
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/trade-analyzer-session', () => ({ saveTradeAnalyzerDraft: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true


it('keeps pick order in a saved offline analysis', async () => {
    const picks = [
        { kind: 'pick', id: 'r2-2030', label: '2030 Round 2', round: 2, seasonYear: 2029, teams: 10 },
        { kind: 'pick', id: 'r1-2031', label: '2031 Round 1', round: 1, seasonYear: 2030, teams: 10 },
        { kind: 'pick', id: 'r1-2029', label: '2029 Round 1', round: 1, seasonYear: 2028, teams: 10 },
    ] as const
    const analysis = analyzeDynastyTrade({ leagueId: 'league', seasonYear: 2027, scoringSettings: {} }, 'overall', picks.map(asset => ({
        fromMemberId: 'me', toMemberId: 'them', asset: { ...asset, slot: null, valueBands: { early: 500, mid: 400, late: 300 } },
    })))
    saved.value = JSON.parse(JSON.stringify(analysis)) as DynastyTradeAnalysis
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.onPress())
    const labels = renderer.root.findAllByType('Text' as React.ElementType).flatMap(node =>
        typeof node.props.children === 'string' && /Round/.test(node.props.children) ? [node.props.children] : [])
    await act(async () => renderer.unmount())
    expect(labels).toEqual(['2029 Round 1', '2031 Round 1', '2030 Round 2'])
})
