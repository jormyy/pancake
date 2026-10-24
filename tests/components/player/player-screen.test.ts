import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlayerDetailScreen from '@/app/player/[id]'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { StatsOverview } from '@/components/player/StatsOverview'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { headerPlayer, memberTransactionState } from '@/tests/helpers/fixtures'

const state = vi.hoisted(() => ({
    data: {} as Record<string, unknown>, roster: vi.fn(), add: vi.fn(), push: vi.fn(),
    refresh: undefined as (() => Promise<void>) | undefined,
    canRead: () => true, isCurrent: () => true,
}))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ id: 'player' }), useRouter: () => ({ push: state.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', scoring_settings: { points: 1 } }, membershipValidated: true }) }))
vi.mock('@/hooks/use-player-screen-data', () => ({ usePlayerScreenData: () => state.data }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/use-quick-add', () => ({ useQuickAdd: (options: { onChanged: () => Promise<void> }) => {
    state.refresh = options.onChanged
    return { adding: null, addBlockedReason: null, handleAdd: state.add, dropPickerPlayer: null, irModal: null }
} }))
vi.mock('@/lib/roster-add-flow', () => ({ loadPickupState: state.roster }))
vi.mock('@/lib/roster', () => ({ dropPlayer: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/components/ui', () => ({ Page: 'Page', FilterSelect: 'FilterSelect', BackButton: 'BackButton', usePageMetrics: () => ({ padX: 16, usableWidth: 370 }) }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui/useEdgeFade', () => ({ useEdgeFade: () => ({}) }))
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: () => null }))
vi.mock('@/components/DropPlayerPickerModal', () => ({ DropPlayerPickerModal: () => null }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: () => null }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
const button = () => screen!.root.findByProps({ accessibilityLabel: 'Add Player A' })
beforeEach(() => {
    vi.clearAllMocks()
    state.data = {
        player: { ...headerPlayer(), id: 'player' }, loading: false, canRead: state.canRead,
        readEpoch: 'first', isCurrentRead: state.isCurrent, rosterRevision: 0,
        availableSeasons: [2026, 2025], selectedSeason: 2026, seasonAverages: null, seasonLoading: true,
        gameLog: [], fantasyPointsMap: new Map(), avgFantasyPoints: 0,
        nextProjection: null, projectionSettled: false, transactions: [],
    }
    state.roster.mockResolvedValue({ status: { status: 'free_agent' }, transactionState: memberTransactionState(), claimPending: false })
})
afterEach(async () => { await act(async () => { screen?.unmount() }); screen = undefined })

it('paints the header and independent card placeholders while every detail read is pending', async () => {
    state.data.player = null
    state.data.loading = true
    state.roster.mockReturnValue(new Promise(() => {}))
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    expect(screen!.root.findByType(PlayerHeader).props.player.display_name).toBe('Player')
    expect(screen!.root.findByType(StatsOverview).props.loading).toBe(true)
    expect(screen!.root.findByType(NextProjectionCard).props.loading).toBe(true)
    expect(screen!.root.findByProps({ testID: 'player-action-slot' })).toBeDefined()
    expect(JSON.stringify(screen!.toJSON())).toContain('Loading recent games')
})

it('never removes, relabels or disables Add during status refresh, failure, or unrelated stats updates', async () => {
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    expect(button().props.disabled).toBe(false)
    let reject!: (error: Error) => void
    state.roster.mockReturnValueOnce(new Promise((_, failure) => { reject = failure }))
    let refresh!: Promise<void>
    await act(async () => { refresh = state.refresh!() })
    expect(button().props.disabled).toBe(false)
    expect(button().findByProps({ children: 'Add' })).toBeDefined()
    state.data = { ...state.data, avgFantasyPoints: 45, projectionSettled: true }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    expect(state.roster).toHaveBeenCalledTimes(2)
    expect(button().props.disabled).toBe(false)
    await act(async () => { reject(new Error('unavailable')); await refresh })
    expect(button().props.disabled).toBe(false)
    await act(async () => button().props.onPress())
    expect(state.add).toHaveBeenCalledWith({ id: 'player', display_name: 'Player A' })
})

it('reads known roster status only for roster signals and exposes retry after a cold failure', async () => {
    state.roster.mockRejectedValueOnce(new Error('unavailable'))
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const retry = screen!.root.findByProps({ accessibilityLabel: 'Retry Player A' })
    expect(retry.props.disabled).toBe(false)
    await act(async () => { await retry.props.onPress() })
    expect(button().props.disabled).toBe(false)
    expect(state.roster).toHaveBeenCalledTimes(2)
    state.data = { ...state.data, readEpoch: 'resumed' }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    expect(state.roster).toHaveBeenCalledTimes(2)
    state.data = { ...state.data, rosterRevision: 1 }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    expect(state.roster).toHaveBeenCalledTimes(3)
})
