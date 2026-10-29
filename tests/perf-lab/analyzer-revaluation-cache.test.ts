import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import TradeAnalyzer from '@/components/trades/TradeAnalyzer'

const state = vi.hoisted(() => ({ online: true, cache: new Map<string, unknown>(), analysis: { assets: [{ kind: 'player', assetId: 'player', label: 'Saved player' }], teams: [{ memberId: 'me' }] } }))
const composer = vi.hoisted(() => ({ participantIds: ['me', 'them'], participantRosters: {}, participantViews: [], assetsReady: true, selectedAssetsAvailable: true,
    selectedParticipantIds: new Set(), buildMultiTeamItems: () => [{ kind: 'player', fromMemberId: 'me', toMemberId: 'them', playerId: 'player' }], reset: () => {},
    setParticipantIds: () => {}, prefillFromTrade: () => {}, participantName: () => 'My team' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value }, Pressable: 'Pressable', Text: 'Text', View: 'View', ScrollView: 'ScrollView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/ui/Page', () => ({ usePageMetrics: () => ({ usableWidth: 402 }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: 'MultiTeamTradeBuilder' }))
vi.mock('@/components/trades/TradeAnalysisSummary', () => ({ TradeAnalysisSummary: 'TradeAnalysisSummary' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'me', team_name: 'My team' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => state.online }))
vi.mock('@/hooks/use-multi-team-trade-composer', () => ({ useMultiTeamTradeComposer: () => composer }))
vi.mock('@/hooks/use-dynasty-trade-analysis', () => ({ useDynastyTradeAnalysis: () => ({ analysis: state.online ? state.analysis : null, seasonYear: state.online ? 2027 : null, loading: false, error: null }) }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: async () => [{ id: 'them', team_name: 'Other team' }], isTradingClosed: () => false }))
vi.mock('@/lib/dynasty-decisions', () => ({ dynastyAnalyzerLatestScopeCacheKey: () => 'scope', dynastyAnalyzerLatestRouteCacheKey: () => 'route',
    dynastyAnalyzerSnapshotCacheKey: (_scope: unknown, signature: string) => `snapshot:${signature}`, dynastyAnalyzerRouteSignature: (items: { playerId: string }[]) => items.map(item => item.playerId).join(','), dynastyScoringSignature: () => 'scoring' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: (key: string) => state.cache.get(key), writePersistentCache: (key: string, value: unknown) => state.cache.set(key, value) }))
vi.mock('@/lib/trade-analyzer-session', () => ({ saveTradeAnalyzerDraft: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('reopens an online trade revaluation offline with its saved analysis', async () => {
    state.cache.clear()
    state.online = true
    const trade = { id: 'trade', isMultiTeam: false, routedItems: [] } as never
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer, { prefillTrade: trade })) })
    expect(state.cache.has('snapshot:revaluation:trade:player')).toBe(true)
    await act(async () => { renderer.unmount() })
    state.online = false
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer, { prefillTrade: trade })) })
    try {
        const summary = renderer.root.findByType('TradeAnalysisSummary' as React.ElementType)
        expect(summary.props.analysis).toEqual(state.analysis)
        expect(summary.props.cached).toBe(true)
    } finally {
        await act(async () => { renderer.unmount() })
        state.online = true
    }
})

it('keeps an unchanged historical result available after Edit assets while offline', async () => {
    state.cache.clear()
    state.online = true
    const trade = { id: 'trade', isMultiTeam: false, routedItems: [] } as never
    const originalBuilder = composer.buildMultiTeamItems
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer, { prefillTrade: trade })) })
    await act(async () => { renderer.unmount() })
    state.online = false
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer, { prefillTrade: trade })) })
    try {
        await act(async () => { renderer.root.findByProps({ title: 'Edit assets' }).props.onPress() })
        const view = renderer.root.findByProps({ accessibilityLabel: 'View trade analysis' })
        expect(view.props.disabled).toBe(false)
        await act(async () => { view.props.onPress() })
        expect(renderer.root.findByType('TradeAnalysisSummary' as React.ElementType).props).toMatchObject({ analysis: state.analysis, cached: true })
        await act(async () => { renderer.root.findByProps({ title: 'Edit assets' }).props.onPress() })
        composer.buildMultiTeamItems = () => [{ kind: 'player', fromMemberId: 'me', toMemberId: 'them', playerId: 'changed-player' }]
        await act(async () => { renderer.update(React.createElement(TradeAnalyzer, { prefillTrade: trade })) })
        expect(renderer.root.findByProps({ accessibilityLabel: 'View trade analysis' }).props.disabled).toBe(true)
    } finally {
        composer.buildMultiTeamItems = originalBuilder
        await act(async () => { renderer.unmount() })
        state.online = true
    }
})


it('retains the saved team choices on an offline remount', async () => {
    state.cache.clear()
    state.online = true
    composer.selectedParticipantIds.clear()
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Analyze with Other team' })).toHaveLength(1)
    await act(async () => { renderer.unmount() })
    state.online = false
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    try {
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Analyze with Other team' })).toHaveLength(1)
    } finally {
        await act(async () => { renderer.unmount() })
        state.online = true
    }
})

it('removes the selected opponent when the Remove control is pressed', async () => {
    state.online = true
    composer.selectedParticipantIds.add('them')
    const setParticipants = vi.spyOn(composer, 'setParticipantIds')
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
    try {
        await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Remove Other team' }).props.onPress() })
        expect(setParticipants).toHaveBeenLastCalledWith(['me'])
    } finally {
        await act(async () => { renderer.unmount() })
        composer.selectedParticipantIds.clear()
        setParticipants.mockRestore()
    }
})
