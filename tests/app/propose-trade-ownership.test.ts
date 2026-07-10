import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProposeTradeScreen from '@/app/(modals)/propose-trade'

const mocks = vi.hoisted(() => ({
    back: vi.fn(),
    context: {
        current: { id: 'member-a', team_name: 'Team A' },
        currentLeague: {
            id: 'league-a',
            status: 'active',
            trade_deadline: null,
            waiver_mode: 'faab',
        },
    },
    getLeagueMembers: vi.fn(),
    getTradeById: vi.fn(),
    params: {} as Record<string, string | undefined>,
    prefillFromTrade: vi.fn(),
    showAlert: vi.fn(),
    showSuccess: vi.fn(),
    submitTradeComposer: vi.fn(),
    tradeItems: [] as { kind: 'player'; fromMemberId: string; toMemberId: string; playerId: string }[],
}))

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: <Value,>(options: { default?: Value; ios?: Value }) => options.ios ?? options.default },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    View: 'View',
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => mocks.params,
    useRouter: () => ({ back: mocks.back }),
}))
vi.mock('@/contexts/league-context', () => ({
    useLeagueContext: () => mocks.context,
}))
vi.mock('@/hooks/use-multi-team-trade-composer', () => ({
    useMultiTeamTradeComposer: () => ({
        assetsReady: true,
        avgMap: new Map(),
        avgStatsMap: new Map(),
        buildMultiTeamItems: () => mocks.tradeItems,
        loadedParticipantKey: 'member-a,member-b',
        participantIds: ['member-a', 'member-b'],
        participantName: vi.fn(),
        participantViews: [{ memberId: 'member-a' }, { memberId: 'member-b' }],
        prefillFromTrade: mocks.prefillFromTrade,
        reset: vi.fn(),
        retry: vi.fn(),
        rosterError: null,
        rosterLoading: false,
        selectParticipantAsset: vi.fn(),
        selectedParticipantIds: new Set(),
        setParticipantDestination: vi.fn(),
        setParticipantFaab: vi.fn(),
        setParticipantIds: vi.fn(),
        setParticipantPickDestination: vi.fn(),
        setParticipantPlayerDestination: vi.fn(),
        toggleParticipant: vi.fn(),
        toggleParticipantPick: vi.fn(),
        toggleParticipantPlayer: vi.fn(),
    }),
}))
vi.mock('@/lib/trade-composer', () => ({
    buildTwoTeamTradeComposerPayload: () => ({ hasOffer: true, hasRequest: true, payload: {} }),
    getTradeComposerMode: (params: Record<string, string | undefined>) => ({
        mode: params.editTradeId ? 'edit' : params.counterTradeId ? 'counter' : 'propose',
        editTradeId: params.editTradeId ?? null,
        counterTradeId: params.counterTradeId ?? null,
        sourceTradeId: params.editTradeId ?? params.counterTradeId ?? null,
    }),
    prefillTradeComposerFromTrade: () => ({
        selectedRecipientId: 'member-b',
        notes: '',
        expirationDays: '3',
    }),
    submitMultiTeamTradeComposer: vi.fn(),
    submitTradeComposer: mocks.submitTradeComposer,
    tradeComposerSuccessCopy: () => ({ title: 'Sent', message: 'Trade sent.' }),
    tradeComposerTitle: () => 'Propose Trade',
    validateTradeExpirationDays: (value: string) => ({
        days: value === '' ? null : Number(value),
        error: null,
    }),
}))
vi.mock('@/lib/trades', () => ({
    counterMultiTeamTrade: vi.fn(),
    counterTrade: vi.fn(),
    editMultiTeamTrade: vi.fn(),
    editTrade: vi.fn(),
    getCurrentSeasonId: vi.fn(),
    getTradeById: mocks.getTradeById,
    proposeMultiTeamTrade: vi.fn(),
    proposeTrade: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    showAlert: mocks.showAlert,
    showSuccess: mocks.showSuccess,
}))
vi.mock('@/lib/league', () => ({
    getLeagueMembers: mocks.getLeagueMembers,
    isTradingClosed: () => false,
}))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: () => null }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('@/components/ui', () => ({ ErrorBanner: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.params = { recipientMemberId: 'member-b' }
    mocks.context = {
        current: { id: 'member-a', team_name: 'Team A' },
        currentLeague: {
            id: 'league-a',
            status: 'active',
            trade_deadline: null,
            waiver_mode: 'faab',
        },
    }
    mocks.getLeagueMembers.mockResolvedValue([{ id: 'member-b', team_name: 'Team B' }])
    mocks.getTradeById.mockResolvedValue(null)
    mocks.submitTradeComposer.mockResolvedValue(undefined)
    mocks.tradeItems = [
        { kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-a' },
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'player-b' },
    ]
})

describe('propose trade async ownership', () => {
    it('announces the 100-item ceiling without disabling a valid boundary draft', async () => {
        mocks.tradeItems = Array.from({ length: 100 }, (_, index) => ({
            kind: 'player' as const,
            fromMemberId: index % 2 === 0 ? 'member-a' : 'member-b',
            toMemberId: index % 2 === 0 ? 'member-b' : 'member-a',
            playerId: `player-${index}`,
        }))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })

        const banner = renderer.root.findByProps({ testID: 'trade-item-limit' })
        expect(banner.props.children.props.children).toBe('Trade item limit reached. Remove an item before selecting another.')
        expect(renderer.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('announces an oversized draft and disables submission', async () => {
        mocks.tradeItems = Array.from({ length: 101 }, (_, index) => ({
            kind: 'player' as const,
            fromMemberId: index % 2 === 0 ? 'member-a' : 'member-b',
            toMemberId: index % 2 === 0 ? 'member-b' : 'member-a',
            playerId: `player-${index}`,
        }))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })

        const banner = renderer.root.findByProps({ testID: 'trade-item-limit' })
        expect(banner.props.accessibilityRole).toBe('alert')
        expect(banner.props.children.props.children).toBe('This trade has 101 items. Remove 1 to meet the 100-item limit.')
        expect(renderer.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('does not show a source-trade error after the modal unmounts', async () => {
        const sourceTrade = deferred<never>()
        mocks.params = { editTradeId: 'trade-a' }
        mocks.getTradeById.mockReturnValue(sourceTrade.promise)
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { sourceTrade.reject(new Error('trade offline')); await sourceTrade.promise.catch(() => undefined) })

        expect(mocks.showAlert).not.toHaveBeenCalled()
    })

    it('does not show success or navigate after submission outlives the modal', async () => {
        const submission = deferred<void>()
        mocks.submitTradeComposer.mockReturnValue(submission.promise)
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        const submit = renderer.root.findByProps({ testID: 'trade-submit' })
        let pending!: Promise<void>
        await act(async () => { pending = submit.props.onPress(); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { submission.resolve(); await pending })

        expect(mocks.showSuccess).not.toHaveBeenCalled()
        expect(mocks.back).not.toHaveBeenCalled()
    })

    it('does not complete a prior owner submission after league identity changes', async () => {
        const submission = deferred<void>()
        mocks.submitTradeComposer.mockReturnValue(submission.promise)
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        const submit = renderer.root.findByProps({ testID: 'trade-submit' })
        let pending!: Promise<void>
        await act(async () => { pending = submit.props.onPress(); await Promise.resolve() })
        mocks.context = {
            current: { id: 'member-c', team_name: 'Team C' },
            currentLeague: {
                id: 'league-c',
                status: 'active',
                trade_deadline: null,
                waiver_mode: 'faab',
            },
        }
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { submission.resolve(); await pending })

        expect(mocks.showSuccess).not.toHaveBeenCalled()
        expect(mocks.back).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})
