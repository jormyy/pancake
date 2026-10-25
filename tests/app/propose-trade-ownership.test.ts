import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProposeTradeScreen from '@/app/(modals)/propose-trade'
import { RequestError } from '@/lib/shared/errors'
import { clearSessionCaches } from '@/lib/session-cache-registry'
import { MAX_TRADE_FAAB_AMOUNT, MAX_TRADE_PARTICIPANTS } from '@pancake/core'

type MockTradeItem =
    | { kind: 'player'; fromMemberId: string; toMemberId: string; playerId: string }
    | { kind: 'faab'; fromMemberId: string; toMemberId: string; faabAmount: number }

const mocks = vi.hoisted(() => ({
    userId: 'user-a',
    selectedAssetsAvailable: true,
    assetsLoaded: true,
    tradingClosed: false,
    getCurrentSeasonId: vi.fn(),
    invalidateSeasonCache: vi.fn(),
    back: vi.fn(),
    context: {
        online: true,
        current: { id: 'member-a', team_name: 'Team A' },
        currentLeague: {
            id: 'league-a',
            status: 'active',
            trade_deadline: null,
            waiver_mode: 'faab',
            allow_inactive_trades: false,
            ir_slots: 2,
            taxi_slots: 3,
        },
    },
    getLeagueMembers: vi.fn(),
    getTradeById: vi.fn(),
    params: {} as Record<string, string | undefined>,
    participantIds: ['member-a', 'member-b'],
    prefillFromTrade: vi.fn(),
    prefillFromItems: vi.fn(),
    showAlert: vi.fn(),
    showSuccess: vi.fn(),
    submitMultiTeamTradeComposer: vi.fn(),
    submitTradeComposer: vi.fn(),
    tradeItems: [] as MockTradeItem[],
}))

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'ios', select: <Value,>(options: { default?: Value; ios?: Value }) => options.ios ?? options.default },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('expo-modules-core', () => ({ uuid: { v4: () => crypto.randomUUID() } }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
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
        assetsLoaded: mocks.assetsLoaded,
        selectedAssetsAvailable: mocks.selectedAssetsAvailable,
        avgMap: new Map(),
        avgStatsMap: new Map(),
        buildMultiTeamItems: () => mocks.tradeItems,
        loadedParticipantKey: 'member-a,member-b',
        participantIds: mocks.participantIds,
        participantName: vi.fn(),
        participantRosters: {
            'member-a': ['player-a', 'drop', 'keep-drop'].map(id => ({ players: { id, display_name: id } })),
            'member-b': ['player-b', 'incoming-taxi', 'incoming-ir'].map(id => ({ players: { id, display_name: id } })),
        },
        participantViews: mocks.participantIds.map((memberId) => ({ memberId })),
        prefillFromTrade: mocks.prefillFromTrade,
        prefillFromItems: mocks.prefillFromItems,
        reset: vi.fn(),
        retry: vi.fn(),
        rosterError: null,
        rosterLoading: false,
        selectParticipantAsset: vi.fn(),
        removeParticipantAsset: vi.fn(),
        selectedParticipantIds: new Set(mocks.participantIds.slice(1)),
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
vi.mock('@/hooks/use-dynasty-trade-analysis', () => ({
    useDynastyTradeAnalysis: () => ({ analysis: null, loading: false, error: null }),
}))
vi.mock('@/lib/trade-analyzer-session', () => ({ takeTradeAnalyzerDraft: () => null }))
vi.mock('@/lib/trade-composer', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/trade-composer')>(),
    buildTwoTeamTradeComposerPayload: (items: MockTradeItem[]) => ({
        hasOffer: true,
        hasRequest: true,
        faabError: items.some((item) => item.kind === 'faab' && item.faabAmount > 1_000_000)
            ? 'FAAB amount cannot exceed 1,000,000.'
            : null,
        payload: { offerPlayerIds: ['player-a'], requestPlayerIds: ['player-b'], offerPickIds: [], requestPickIds: [],
            expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    }),
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
    submitMultiTeamTradeComposer: mocks.submitMultiTeamTradeComposer,
    submitTradeComposer: mocks.submitTradeComposer,
    tradeComposerSuccessCopy: () => ({ title: 'Sent', message: 'Trade sent.' }),
    tradeComposerTitle: () => 'Propose Trade',
    validateTradeExpirationDays: (value: string) => ({
        days: value === '' ? null : Number(value),
        error: null,
    }),
    validateTradeNotes: (value: string) => ({
        error: new TextEncoder().encode(value).length > 2_000
            ? 'Notes must contain at most 2000 UTF-8 bytes.'
            : null,
    }),
}))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: mocks.invalidateSeasonCache }))
vi.mock('@/lib/trades', () => ({
    counterMultiTeamTrade: vi.fn(),
    counterTrade: vi.fn(),
    editMultiTeamTrade: vi.fn(),
    editTrade: vi.fn(),
    getCurrentSeasonId: mocks.getCurrentSeasonId,
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
    isTradingClosed: () => mocks.tradingClosed,
}))
vi.mock('@/components/trades/TradeRosterPlanEditor', () => ({ TradeRosterPlanEditor: 'TradeRosterPlanEditor' }))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: 'MultiTeamTradeBuilder' }))
vi.mock('@/components/trades/TradeAnalysisSummary', () => ({ TradeAnalysisSummary: 'TradeAnalysisSummary' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('@/components/ui', () => ({ ErrorBanner: () => null }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

beforeEach(() => {
    mocks.assetsLoaded = true
    vi.clearAllMocks()
    mocks.userId = 'user-a'
    mocks.selectedAssetsAvailable = true
    mocks.tradingClosed = false
    mocks.getCurrentSeasonId.mockResolvedValue('season-a')
    mocks.params = { recipientMemberId: 'member-b' }
    mocks.context = {
        online: true,
        current: { id: 'member-a', team_name: 'Team A' },
        currentLeague: {
            id: 'league-a',
            status: 'active',
            trade_deadline: null,
            waiver_mode: 'faab',
            allow_inactive_trades: false,
            ir_slots: 2,
            taxi_slots: 3,
        },
    }
    mocks.getLeagueMembers.mockImplementation(async () => [{ id: mocks.context.current.id, user_id: mocks.userId, team_name: 'My team' }, { id: 'member-b', team_name: 'Team B' }])
    mocks.getTradeById.mockResolvedValue(null)
    mocks.participantIds = ['member-a', 'member-b']
    mocks.submitMultiTeamTradeComposer.mockResolvedValue(undefined)
    mocks.submitTradeComposer.mockResolvedValue(undefined)
    mocks.tradeItems = [
        { kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-a' },
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'player-b' },
    ]
})

describe('propose trade async ownership', () => {
    it.each([['two', 'P0001'], ['multi', 'P0001'], ['two', 'PT001'], ['multi', 'PT001']])('recovers %s-team proposal after a definite %s rejection', async (form, code) => {
        const send = form === 'multi' ? mocks.submitMultiTeamTradeComposer : mocks.submitTradeComposer
        if (form === 'multi') {
            mocks.participantIds = ['member-a', 'member-b', 'member-c']
            mocks.tradeItems = [
                { kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-a' },
                { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-c', playerId: 'player-b' },
                { kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' },
            ]
        }
        send.mockImplementation(async (_input, deps) => {
            if (await deps.getCurrentSeasonId() === 'season-a') {
                throw new RequestError('No active season found.', { code })
            }
        })
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        if (form === 'multi') await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        const rejectedKey = send.mock.calls[0][0].requestId
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
        mocks.getCurrentSeasonId.mockResolvedValue('season-b')
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(mocks.getCurrentSeasonId).toHaveBeenCalledTimes(2)
        expect(mocks.invalidateSeasonCache).toHaveBeenCalledWith('league-a')
        expect(send.mock.calls[1][0].requestId).not.toBe(rejectedKey)
        expect(mocks.showSuccess).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

    it.each(['two', 'multi'])('regenerates %s-team expiration only after a definite expired-request rejection', async (form) => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
        const send = form === 'multi' ? mocks.submitMultiTeamTradeComposer : mocks.submitTradeComposer
        if (form === 'multi') {
            mocks.participantIds = ['member-a', 'member-b', 'member-c']
            mocks.tradeItems.push({ kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' })
        }
        send.mockRejectedValueOnce(new Error('Connection lost before response'))
            .mockRejectedValueOnce(new RequestError('Trade expiration must be in the future.', { code: '22023' }))
            .mockResolvedValue(undefined)
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
            if (form === 'multi') await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })
            await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            const first = send.mock.calls[0][0]
            clock.mockReturnValue(1_800_000_000_000 + 4 * 86_400_000)
            await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            expect(send.mock.calls[1][0]).toEqual(first)
            await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            const final = send.mock.calls[2][0]
            expect(final.requestId).not.toBe(first.requestId)
            if (form === 'multi') expect(final.nowMs).toBe(Date.now())
            else expect(Date.parse(final.payload.expiresAt)).toBeGreaterThan(Date.now())
            expect(mocks.showSuccess).toHaveBeenCalledTimes(1)
        } finally {
            if (renderer) await act(async () => { renderer.unmount() })
            clock.mockRestore()
        }
    })

    it('retains a conflicting receipt instead of silently creating a second request', async () => {
        mocks.submitTradeComposer.mockRejectedValue(new RequestError('This request key already belongs to different trade terms.', { code: '22023' }))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(mocks.submitTradeComposer.mock.calls[1][0]).toEqual(mocks.submitTradeComposer.mock.calls[0][0])
        await act(async () => { renderer.unmount() })
    })

    it('retains a request even when immediate failure batches away the busy render', async () => {
        mocks.submitTradeComposer.mockRejectedValueOnce(new Error('Lost reply')).mockResolvedValue(undefined)
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(mocks.submitTradeComposer.mock.calls[1][0]).toEqual(mocks.submitTradeComposer.mock.calls[0][0])
        await act(async () => { renderer.unmount() })
    })

    it('retries the same request and frozen terms after a lost reply, even when assets or trading change', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
        mocks.submitTradeComposer.mockImplementation(async (_input, deps) => {
            await deps.getCurrentSeasonId()
            if (mocks.submitTradeComposer.mock.calls.length === 1) throw new Error('Reply lost')
        })
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
            await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            const first = mocks.submitTradeComposer.mock.calls[0][0]
            expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
            clock.mockReturnValue(1_800_001_000_000)
            mocks.selectedAssetsAvailable = false
            mocks.tradingClosed = true
            mocks.getCurrentSeasonId.mockResolvedValue('season-b')
            await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
            expect(renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.disabled).toBe(false)
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            expect(mocks.submitTradeComposer.mock.calls[1][0]).toEqual(first)
            expect(mocks.getCurrentSeasonId).toHaveBeenCalledTimes(1)
            expect(mocks.showSuccess).toHaveBeenCalledTimes(1)
        } finally {
            if (renderer) await act(async () => { renderer.unmount() })
            clock.mockRestore()
        }
    })

    it('gives changed trade terms a new request after a failed send', async () => {
        mocks.submitTradeComposer.mockRejectedValue(new Error('Reply lost'))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        const firstId = mocks.submitTradeComposer.mock.calls[0][0].requestId
        mocks.tradeItems = [...mocks.tradeItems, { kind: 'faab', fromMemberId: 'member-a', toMemberId: 'member-b', faabAmount: 3 }]
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(mocks.submitTradeComposer.mock.calls[1][0].requestId).not.toBe(firstId)
        await act(async () => { renderer.unmount() })
    })

    it('does not replay a failed attempt under a different signed-in user', async () => {
        mocks.submitTradeComposer.mockRejectedValue(new Error('Reply lost'))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        mocks.userId = 'user-b'
        mocks.selectedAssetsAvailable = false
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
        expect(renderer.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(true)
        expect(mocks.submitTradeComposer).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

    it('keeps the multi-team expiration clock and item routes on retry', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
        mocks.participantIds = ['member-a', 'member-b', 'member-c']
        mocks.tradeItems = [
            { kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-a' },
            { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-c', playerId: 'player-b' },
            { kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' },
        ]
        mocks.submitMultiTeamTradeComposer.mockRejectedValueOnce(new Error('Reply lost')).mockResolvedValue(undefined)
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
            await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })
            await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            const first = structuredClone(mocks.submitMultiTeamTradeComposer.mock.calls[0][0])
            clock.mockReturnValue(1_800_001_000_000)
            await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)) })
            await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
            expect(mocks.submitMultiTeamTradeComposer.mock.calls[1][0]).toEqual(first)
            expect(first.nowMs).toBe(1_800_000_000_000)
            expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
        } finally {
            if (renderer) await act(async () => { renderer.unmount() })
            clock.mockRestore()
        }
    })

    it('reviews a multi-team trade before confirming submission', async () => {
        mocks.participantIds = ['member-a', 'member-b', 'member-c']
        mocks.tradeItems = [
            { kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-a' },
            { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-c', playerId: 'player-b' },
            { kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' },
        ]
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })

        const review = renderer.root.findByProps({ testID: 'trade-submit' })
        expect(review.props.accessibilityLabel).toBe('Review trade proposal')
        await act(async () => { review.props.onPress() })
        // Review replaces the editor: its Send button shows and the editor's Review button is gone.
        expect(renderer.root.findAllByProps({ testID: 'trade-confirm-submit' })).not.toHaveLength(0)
        expect(renderer.root.findAllByProps({ testID: 'trade-submit' })).toHaveLength(0)
        expect(mocks.submitMultiTeamTradeComposer).not.toHaveBeenCalled()

        await act(async () => {
            await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress()
        })
        expect(mocks.submitMultiTeamTradeComposer).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

    it.each([
        ['2-Team', MAX_TRADE_FAAB_AMOUNT, false],
        ['2-Team', MAX_TRADE_FAAB_AMOUNT + 1, true],
        ['Multi-Team', MAX_TRADE_FAAB_AMOUNT, false],
        ['Multi-Team', MAX_TRADE_FAAB_AMOUNT + 1, true],
    ] as const)('%s Send readiness for FAAB amount %i', async (mode, amount, disabled) => {
        if (mode === 'Multi-Team') {
            mocks.participantIds = ['member-a', 'member-b', 'member-c']
            mocks.tradeItems = [
                { kind: 'faab', fromMemberId: 'member-a', toMemberId: 'member-b', faabAmount: amount },
                { kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' },
            ]
        } else {
            mocks.tradeItems = [
                { kind: 'faab', fromMemberId: 'member-a', toMemberId: 'member-b', faabAmount: amount },
                { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'player-b' },
            ]
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        if (mode === 'Multi-Team') {
            await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })
        }

        expect(renderer.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(disabled)
        await act(async () => { renderer.unmount() })
    })

    it('disables a 13th participant selection at the 12-team boundary', async () => {
        mocks.participantIds = Array.from(
            { length: MAX_TRADE_PARTICIPANTS },
            (_, index) => index === 0 ? 'member-a' : `member-${index}`,
        )
        const candidateId = `member-${MAX_TRADE_PARTICIPANTS}`
        mocks.getLeagueMembers.mockResolvedValue([
            { id: 'member-a', user_id: 'user-a', team_name: 'My team' },
            ...mocks.participantIds.slice(1).map((id) => ({ id, team_name: id })),
            { id: candidateId, team_name: candidateId },
        ])
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { renderer.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress() })

        const candidate = renderer.root.findByProps({ testID: `trade-participant-${candidateId}` })
        expect(candidate.props.disabled).toBe(true)
        expect(candidate.props.accessibilityState).toEqual({ selected: false, disabled: true })
        await act(async () => { renderer.unmount() })
    })

    it.each([
        [2_000, false],
        [2_001, true],
    ])('sets Send readiness for %i note characters', async (length, disabled) => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })

        const builder = renderer.root.findByProps({ expirationDays: '3', notes: '' })
        await act(async () => { builder.props.onNotesChange('n'.repeat(length)) })

        expect(renderer.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(disabled)
        await act(async () => { renderer.unmount() })
    })

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
        await act(async () => { submit.props.onPress(); await Promise.resolve() })
        await act(async () => { pending = renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress(); await Promise.resolve() })
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
        await act(async () => { submit.props.onPress(); await Promise.resolve() })
        await act(async () => { pending = renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress(); await Promise.resolve() })
        mocks.context = {
        online: true,
            current: { id: 'member-c', team_name: 'Team C' },
            currentLeague: {
                id: 'league-c',
                status: 'active',
                trade_deadline: null,
                waiver_mode: 'faab',
            allow_inactive_trades: false,
            ir_slots: 2,
            taxi_slots: 3,
            },
        }
        await act(async () => { renderer.update(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        await act(async () => { submission.resolve(); await pending })

        expect(mocks.showSuccess).not.toHaveBeenCalled()
        expect(mocks.back).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})

describe('unsent trade across a page reload', () => {
    const draftKey = 'pancake:trade-composer-draft'
    let stored: Map<string, string>
    beforeEach(() => {
        stored = new Map()
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => { stored.set(key, value) },
            removeItem: (key: string) => { stored.delete(key) },
        })
    })
    afterEach(() => { vi.unstubAllGlobals() })

    const mount = async () => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
        return renderer
    }
    const builder = (renderer: ReactTestRenderer) => renderer.root.findByType('MultiTeamTradeBuilder' as never)
    // A reload tears the page down without React cleanup, so the saved copy is still there afterwards.
    const reload = async (renderer: ReactTestRenderer) => {
        const saved = stored.get(draftKey)
        await act(async () => { renderer.unmount() })
        if (saved) stored.set(draftKey, saved)
        return mount()
    }

    it('brings back the selected assets, notes and expiry for the same owner', async () => {
        const first = await mount()
        await act(async () => { builder(first).props.onNotesChange('Hold for the deadline') })
        await act(async () => { builder(first).props.onExpirationDaysChange('5') })
        expect(JSON.parse(stored.get(draftKey)!)).toMatchObject({ ownerIdentity: 'user-a:league-a:member-a', mode: 'propose',
            selectedRecipientId: 'member-b', items: mocks.tradeItems, notes: 'Hold for the deadline', expirationDays: '5' })

        const second = await reload(first)
        expect(mocks.prefillFromItems).toHaveBeenCalledWith(['member-a', 'member-b'], mocks.tradeItems)
        expect(builder(second).props.notes).toBe('Hold for the deadline')
        expect(builder(second).props.expirationDays).toBe('5')
        expect(second.root.findByProps({ testID: 'trade-submit' }).props.disabled).toBe(false)
        await act(async () => { second.unmount() })
        expect(stored.has(draftKey)).toBe(false)
    })

    it('restores planned drops and incoming placements after a reload', async () => {
        mocks.context.currentLeague.allow_inactive_trades = true
        const first = await mount()
        await act(async () => first.root.findByProps({ testID: 'trade-submit' }).props.onPress())
        const plan = { taxiPlayerIds: [], irPlayerIds: ['player-b'], dropPlayerIds: ['drop'] }
        await act(async () => first.root.findByType('TradeRosterPlanEditor' as React.ElementType).props.onChange(plan))
        const second = await reload(first)
        await act(async () => second.root.findByProps({ testID: 'trade-submit' }).props.onPress())
        expect(second.root.findByType('TradeRosterPlanEditor' as React.ElementType).props.value).toEqual(plan)
        await act(async () => second.unmount())
    })

    it('never restores another owner\'s trade and drops it', async () => {
        const first = await mount()
        await act(async () => { builder(first).props.onNotesChange('Private note') })
        const saved = stored.get(draftKey)!
        await act(async () => { first.unmount() })
        stored.set(draftKey, saved)
        mocks.userId = 'user-b'
        const other = await mount()
        expect(mocks.prefillFromItems).not.toHaveBeenCalled()
        expect(builder(other).props.notes).toBe('')
        expect(JSON.parse(stored.get(draftKey)!).ownerIdentity).toBe('user-b:league-a:member-a')
        await act(async () => { other.unmount() })
    })

    it.each(['{bad', JSON.stringify({ ownerIdentity: 'user-a:league-a:member-a', mode: 'propose', sourceTradeId: null,
        multiTeamMode: false, selectedRecipientId: 'member-b', participantIds: ['member-a', 'member-b'],
        items: [{ kind: 'faab', fromMemberId: 'member-a', toMemberId: 'member-b', faabAmount: -5 }], notes: '', expirationDays: '3' })])(
        'ignores a damaged saved copy %#', async (saved) => {
            stored.set(draftKey, saved)
            const renderer = await mount()
            expect(mocks.prefillFromItems).not.toHaveBeenCalled()
            expect(JSON.parse(stored.get(draftKey)!).items).toEqual(mocks.tradeItems)
            await act(async () => { renderer.unmount() })
        })

    it('keeps a restored edit instead of reloading the saved trade over it', async () => {
        mocks.params = { editTradeId: 'trade-1' }
        mocks.getTradeById.mockResolvedValue({ id: 'trade-1', isMultiTeam: false })
        const first = await mount()
        await act(async () => { builder(first).props.onNotesChange('Edited terms') })
        mocks.prefillFromTrade.mockClear()
        const second = await reload(first)
        await act(async () => { await Promise.resolve() })
        expect(mocks.prefillFromTrade).not.toHaveBeenCalled()
        expect(builder(second).props.notes).toBe('Edited terms')
        await act(async () => { second.unmount() })
    })

    it('stops keeping a copy once Send starts and while the outcome is unknown', async () => {
        const submission = deferred<void>()
        mocks.submitTradeComposer.mockReturnValueOnce(submission.promise).mockResolvedValue(undefined)
        const renderer = await mount()
        expect(stored.has(draftKey)).toBe(true)
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        let pending!: Promise<void>
        await act(async () => { pending = renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress(); await Promise.resolve() })
        expect(stored.has(draftKey)).toBe(false)
        await act(async () => { submission.reject(new Error('Reply lost')); await pending })
        expect(stored.has(draftKey)).toBe(false)
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(mocks.showSuccess).toHaveBeenCalledTimes(1)
        expect(stored.has(draftKey)).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('keeps the copy again after a definite rejection', async () => {
        mocks.submitTradeComposer.mockRejectedValueOnce(new RequestError('No active season found.', { code: 'P0001' }))
        const renderer = await mount()
        await act(async () => { renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress() })
        await act(async () => { await renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress() })
        expect(stored.has(draftKey)).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('clears the copy when sign-out or an account switch clears session caches', async () => {
        const renderer = await mount()
        expect(stored.has(draftKey)).toBe(true)
        clearSessionCaches()
        expect(stored.has(draftKey)).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})


const activity = vi.hoisted(() => ({ active: true, epoch: 0 }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = {
    canRead: () => activity.active, canAct: () => activity.active,
    capture: () => activity.epoch, isCurrent: (epoch: number) => activity.active && epoch === activity.epoch,
    markReady: () => {}, blockActions: () => {},
}; return { useDraftActivity: () => ({ ...gate, epoch: activity.epoch, ready: activity.active }) } })
beforeEach(() => { activity.active = true; activity.epoch = 0 })

it('defers trade member reads while inactive and reloads once on return', async () => {
    activity.active = false
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(ProposeTradeScreen)) })
    expect(mocks.getLeagueMembers).not.toHaveBeenCalled()
    activity.active = true; activity.epoch += 1
    await act(async () => view.update(React.createElement(ProposeTradeScreen)))
    expect(mocks.getLeagueMembers).toHaveBeenCalledTimes(1)
    await act(async () => view.unmount())
})

it('does not send a trade after membership is removed before confirmation', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(ProposeTradeScreen)) })
    await act(async () => view.root.findByProps({ testID: 'trade-submit' }).props.onPress())
    mocks.getLeagueMembers.mockResolvedValue([])
    await act(async () => view.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress())
    expect(mocks.submitTradeComposer).not.toHaveBeenCalled()
    await act(async () => view.unmount())
})
it('does not read or send from a confirmation retained while the route is inactive', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(ProposeTradeScreen)) })
    await act(async () => view.root.findByProps({ testID: 'trade-submit' }).props.onPress())
    const confirm = view.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress
    mocks.getLeagueMembers.mockClear()
    activity.active = false; activity.epoch += 1
    await act(async () => confirm())
    expect(mocks.getLeagueMembers).not.toHaveBeenCalled()
    expect(mocks.submitTradeComposer).not.toHaveBeenCalled()
    await act(async () => view.unmount())
})

it('clears the former actor notes when the mounted composer changes owners', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(ProposeTradeScreen)) })
    const builder = () => view.root.findByType('MultiTeamTradeBuilder' as never)
    await act(async () => builder().props.onNotesChange('Former actor private note'))
    mocks.userId = 'user-b'
    await act(async () => view.update(React.createElement(ProposeTradeScreen)))
    expect(builder().props.notes).toBe('')
    await act(async () => view.unmount())
})


it('reveals the editor only after selected participant assets settle', async () => {
    let screen!: ReactTestRenderer
    mocks.assetsLoaded = false
    mocks.params = { recipientMemberId: 'member-b' }
    await act(async () => { screen = create(React.createElement(ProposeTradeScreen)) })
    expect(screen.root.findAllByType('MultiTeamTradeBuilder' as React.ElementType)).toHaveLength(0)
    expect(JSON.stringify(screen.toJSON())).not.toContain('Pick a team to trade with')
    mocks.assetsLoaded = true
    await act(async () => screen.update(React.createElement(ProposeTradeScreen)))
    expect(screen.root.findAllByType('MultiTeamTradeBuilder' as React.ElementType)).toHaveLength(1)
    await act(async () => screen.unmount())
})


it.each(['editTradeId', 'counterTradeId'])('locks the original two-team counterparty for %s', async (sourceParam) => {
    mocks.params = { [sourceParam]: 'source' }
    mocks.getTradeById.mockResolvedValue({ id: 'source', isMultiTeam: false })
    mocks.getLeagueMembers.mockResolvedValue([
        { id: 'member-a', user_id: 'user-a', team_name: 'Team A' },
        { id: 'member-b', team_name: 'Team B' },
        { id: 'member-c', team_name: 'Team C' },
    ])
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)); await Promise.resolve() })
    const otherTeam = renderer.root.findByProps({ testID: 'trade-participant-member-c' })
    expect(otherTeam.props.disabled).toBe(true)
    await act(async () => { otherTeam.props.onPress() })
    const originalTeam = renderer.root.findByProps({ testID: 'trade-participant-member-b' })
    expect(originalTeam.props.accessibilityState.selected).toBe(true)
    await act(async () => { renderer.unmount() })
})

it.each(['two', 'multi'])('prunes removed placements and offered drops before the %s-team send', async form => {
    mocks.context.currentLeague.allow_inactive_trades = true
    if (form === 'multi') {
        mocks.participantIds = ['member-a', 'member-b', 'member-c']
        mocks.tradeItems.push({ kind: 'player', fromMemberId: 'member-c', toMemberId: 'member-a', playerId: 'player-c' })
    }
    mocks.tradeItems.push(
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'incoming-taxi' },
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'incoming-ir' },
    )
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(ProposeTradeScreen)) })
    if (form === 'multi') await act(async () => screen.root.findByProps({ testID: 'trade-mode-multi' }).props.onPress())
    await act(async () => screen.root.findByProps({ testID: 'trade-submit' }).props.onPress())
    const editor = () => screen.root.findByType('TradeRosterPlanEditor' as React.ElementType)
    await act(async () => editor().props.onChange({ taxiPlayerIds: ['incoming-taxi'], irPlayerIds: ['incoming-ir', 'player-b'], dropPlayerIds: ['drop', 'keep-drop', 'not-mine'] }))
    mocks.tradeItems = mocks.tradeItems.filter(item => item.kind !== 'player' || !['incoming-taxi', 'incoming-ir'].includes(item.playerId))
    mocks.tradeItems.push({ kind: 'player', fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'drop' })
    await act(async () => screen.update(React.createElement(ProposeTradeScreen)))
    const expected = { taxiPlayerIds: [], irPlayerIds: ['player-b'], dropPlayerIds: ['keep-drop'] }
    expect(editor().props.value).toEqual(expected)
    await act(async () => screen.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress())
    const send = form === 'multi' ? mocks.submitMultiTeamTradeComposer : mocks.submitTradeComposer
    expect(send).toHaveBeenCalledOnce()
    const input = send.mock.calls[0][0]
    expect(form === 'multi' ? input.rosterPlan : input.payload.rosterPlan).toEqual(expected)
    await act(async () => screen.unmount())
})

it.each(['edit', 'counter'])('prefills and submits the actor roster plan in %s mode', async mode => {
    mocks.params = { [mode === 'edit' ? 'editTradeId' : 'counterTradeId']: 'source' }
    mocks.context.currentLeague.allow_inactive_trades = true
    mocks.tradeItems.push(
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'incoming-taxi' },
        { kind: 'player', fromMemberId: 'member-b', toMemberId: 'member-a', playerId: 'incoming-ir' },
    )
    mocks.getTradeById.mockResolvedValue({
        isMultiTeam: false,
        routedItems: [
            { kind: 'player', playerId: 'incoming-taxi', toMemberId: 'member-a', toTaxi: true },
            { kind: 'player', playerId: 'incoming-ir', toMemberId: 'member-a', toIR: true },
            { kind: 'player', playerId: 'player-a', toMemberId: 'member-b', toTaxi: true },
        ],
        participants: [
            { memberId: 'member-a', dropPlayerIds: ['keep-drop', 'player-a', 'gone'] },
            { memberId: 'member-b', dropPlayerIds: ['other-drop'] },
        ],
    })
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(ProposeTradeScreen)) })
        const expected = { taxiPlayerIds: ['incoming-taxi'], irPlayerIds: ['incoming-ir'], dropPlayerIds: ['keep-drop'] }
        await act(async () => renderer.root.findByProps({ testID: 'trade-submit' }).props.onPress())
        expect(renderer.root.findByType('TradeRosterPlanEditor' as React.ElementType).props.value).toEqual(expected)
        await act(async () => renderer.root.findByProps({ testID: 'trade-confirm-submit' }).props.onPress())
        expect(mocks.submitTradeComposer.mock.calls[0][0].payload.rosterPlan).toEqual(expected)
    } finally { await act(async () => renderer?.unmount()) }
})
