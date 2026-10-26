import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import TradeAnalyzer from '@/components/trades/TradeAnalyzer'

const saved = vi.hoisted(() => ({ assets: [{ kind: 'player', assetId: 'player', label: 'Saved player' }], teams: [{ memberId: 'me' }] }))
const composer = vi.hoisted(() => ({
    participantIds: ['me'], participantRosters: {}, participantViews: [] as { memberId: string }[], assetsReady: false, selectedAssetsAvailable: false,
    selectedParticipantIds: new Set(), buildMultiTeamItems: () => [], reset: () => {},
    setParticipantIds: () => {}, prefillFromTrade: () => {}, participantName: () => 'My team',
}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value },
    Pressable: 'Pressable', Text: 'Text', View: 'View', ScrollView: 'ScrollView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/ui/Page', () => ({ usePageMetrics: () => ({ usableWidth: 402 }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: 'MultiTeamTradeBuilder' }))
vi.mock('@/components/trades/TradeAnalysisSummary', () => ({ TradeAnalysisSummary: 'TradeAnalysisSummary' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'me', team_name: 'My team' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => false }))
vi.mock('@/hooks/use-multi-team-trade-composer', () => ({ useMultiTeamTradeComposer: () => composer }))
vi.mock('@/hooks/use-dynasty-trade-analysis', () => ({ useDynastyTradeAnalysis: () => ({ analysis: null, seasonYear: null, loading: false, error: null }) }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: vi.fn(), isTradingClosed: () => false }))
vi.mock('@/lib/dynasty-decisions', () => ({
    dynastyAnalyzerLatestScopeCacheKey: () => 'scope', dynastyAnalyzerLatestRouteCacheKey: () => 'route',
    dynastyAnalyzerSnapshotCacheKey: () => 'snapshot', dynastyAnalyzerRouteSignature: () => '', dynastyScoringSignature: () => '',
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: (key: string) => key === 'scope' ? { seasonYear: 2027 } : key === 'route' ? 'saved-route'
        : { analysis: saved, leagueId: 'league', memberId: 'me', participantNames: { me: 'My team' } },
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/trade-analyzer-session', () => ({ saveTradeAnalyzerDraft: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('opens the saved offline result without rebuilding its asset selection', async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.onPress())
    const summary = renderer.root.findByType('TradeAnalysisSummary' as React.ElementType)
    expect(summary.props.analysis).toBe(saved)
    expect(summary.props.cached).toBe(true)
    expect(renderer.root.findByProps({ accessibilityLabel: 'Make Offer from this analysis' }).props.disabled).toBe(true)
    await act(async () => renderer.unmount())
})


it('hides offer terms in the analyzer', async () => {
    composer.participantViews = [{ memberId: 'me' }, { memberId: 'them' }]
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    const builder = renderer.root.findByType('MultiTeamTradeBuilder' as React.ElementType)
    expect(builder.props.showTerms).toBe(false)
    expect(builder.props.onNotesChange).toBeUndefined()
    expect(builder.props.onExpirationDaysChange).toBeUndefined()
    await act(async () => { renderer.unmount() })
    composer.participantViews = []
})
