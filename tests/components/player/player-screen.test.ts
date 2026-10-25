import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlayerDetailScreen from '@/app/player/[id]'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { StatsOverview } from '@/components/player/StatsOverview'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { headerPlayer, memberTransactionState } from '@/tests/helpers/fixtures'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { notifyMemberClaimsChanged } from '@/lib/claim-updates'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({
    params: { id: 'player', playerHeader: undefined as string | undefined },
    data: {} as Record<string, unknown>, roster: vi.fn(), add: vi.fn(), push: vi.fn(), dismissTo: vi.fn(),
    refresh: undefined as (() => Promise<void>) | undefined,
    canRead: () => true, isCurrent: () => true,
}))
vi.mock('@/components/settings/NotificationPlayerWatch', () => ({ NotificationPlayerWatch: () => null }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => state.params, useRouter: () => ({ push: state.push, dismissTo: state.dismissTo }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', scoring_settings: { points: 1 } }, membershipValidated: true }) }))
vi.mock('@/hooks/use-player-screen-data', () => ({ usePlayerScreenData: vi.fn(() => state.data) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/use-quick-add', () => ({ useQuickAdd: (options: { onChanged: () => Promise<void> }) => {
    state.refresh = options.onChanged
    return { adding: null, addBlockedReason: null, handleAdd: state.add, dropPickerPlayer: null, irModal: null, irMoveCandidates: [] }
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
    state.params = { id: 'player', playerHeader: undefined }
    state.data = {
        player: { ...headerPlayer(), id: 'player' }, loading: false, canRead: state.canRead,
        readEpoch: 'first', isCurrentRead: state.isCurrent, rosterRevision: 0,
        availableSeasons: [2026, 2025], selectedSeason: 2026, seasonAverages: null, seasonLoading: true,
        gameLog: [], fantasyPointsMap: new Map(), avgFantasyPoints: 0,
        nextProjection: null, projectionSettled: false, transactions: [], initialSettled: true,
    }
    state.roster.mockResolvedValue({ status: { status: 'free_agent' }, transactionState: memberTransactionState(), claimPending: false })
})
afterEach(async () => { await act(async () => { screen?.unmount() }); screen = undefined })

it('keeps the persistent player owner stable after a new session for the same member', async () => {
    setSessionOwner('user')
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const firstOwner = vi.mocked(usePlayerScreenData).mock.calls.at(-1)![2]!.ownerKey
    setSessionOwner(null)
    setSessionOwner('user')
    await act(async () => screen!.update(React.createElement(PlayerDetailScreen)))
    expect(vi.mocked(usePlayerScreenData).mock.calls.at(-1)![2]!.ownerKey).toBe(firstOwner)
})

it('reveals one complete initial view and keeps it visible while other resources refresh', async () => {
    state.data.initialSettled = false
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    expect(screen!.root.findAllByType(PlayerHeader)).toHaveLength(0)
    expect(screen!.root.findAllByType(StatsOverview)).toHaveLength(0)
    expect(screen!.root.findAllByType(NextProjectionCard)).toHaveLength(0)
    state.data = { ...state.data, initialSettled: true, seasonLoading: false, projectionSettled: true }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    const header = screen!.root.findByType(PlayerHeader)
    expect(button().props.disabled).toBe(false)
    state.data = { ...state.data, initialSettled: false, seasonLoading: true }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    expect(screen!.root.findByType(PlayerHeader)).toBe(header)
    expect(button().props.disabled).toBe(false)
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
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'player', display_name: 'Player A', injury_status: null, years_exp: 2 }))
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

it('uses the tapped identity when fresh player details are unavailable', async () => {
    state.params.playerHeader = JSON.stringify({ ...headerPlayer({ nba_team: 'BOS' }), id: 'player' })
    state.data.player = null
    state.data.loading = true
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const header = () => screen!.root.findByType(PlayerHeader).props.player
    expect(header().display_name).toBe('Player A')
    expect(header().nba_team).toBe('BOS')
    expect(header().eligible_positions).toEqual(['PG'])
    expect(screen!.root.findByType(StatsOverview).props.loading).toBe(true)
    state.data = { ...state.data, player: { ...headerPlayer({ display_name: 'Fresh name' }), id: 'player' }, loading: false }
    await act(async () => { screen!.update(React.createElement(PlayerDetailScreen)) })
    expect(header().display_name).toBe('Fresh name')
    expect(header().nba_team).toBe('LAL')
})

it.each([
    'invalid json',
    JSON.stringify({ id: 'another-player', display_name: 'Wrong player' }),
    JSON.stringify({ id: 'player', display_name: 'Partial player', eligible_positions: [42] }),
])('ignores invalid or mismatched navigation data: %s', async playerHeader => {
    state.params.playerHeader = playerHeader
    state.data.player = null
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    expect(screen!.root.findByType(PlayerHeader).props.player.display_name).toBe('Player')
})

it('keeps Add to IR visible during roster refresh and passes the injury designation', async () => {
    state.data.player = { ...headerPlayer({ injury_status: 'Out' }), id: 'player' }
    state.roster.mockResolvedValue({ status: { status: 'free_agent' }, transactionState: memberTransactionState(), claimPending: false, roster: [] })
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const action = () => screen!.root.findByProps({ accessibilityLabel: 'Add to IR Player A' })
    expect(action().props.disabled).toBe(false)
    state.roster.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => { void state.refresh!() })
    expect(action().props.disabled).toBe(false)
    await act(async () => action().props.onPress())
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'player', display_name: 'Player A', injury_status: 'Out', years_exp: 2 }))
})

it("opens a trade for another team's player from the main action", async () => {
    state.roster.mockResolvedValue({ status: { status: 'taken', ownerTeamName: 'Other team' }, transactionState: null, claimPending: false })
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const trade = screen!.root.findByProps({ accessibilityLabel: 'Trade Player A' })
    expect(trade.props.disabled).toBe(false)
    await act(async () => trade.props.onPress())
    expect(state.push).toHaveBeenCalledWith('/(modals)/propose-trade?requestPlayerId=player')
    expect(state.add).not.toHaveBeenCalled()
})

it('dismisses the player page when viewing an existing claim', async () => {
    state.roster.mockResolvedValue({ status: { status: 'on_waivers', logId: 'waiver', clearsAt: '2099-01-01' }, transactionState: null, claimPending: true })
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    const action = screen!.root.findByType(PlayerHeader).props.action
    expect(action.label).toBe('View claim')
    await act(async () => action.onPress())
    expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith('/roster?claims=1')
    expect(state.push).not.toHaveBeenCalled()
})

it('changes Claim to View claim after this member submits a claim and ignores other members', async () => {
    state.roster.mockResolvedValue({ status: { status: 'on_waivers' }, transactionState: null, claimPending: false })
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    expect(screen!.root.findByType(PlayerHeader).props.action.label).toBe('Claim')
    await act(async () => notifyMemberClaimsChanged('other'))
    expect(state.roster).toHaveBeenCalledTimes(1)
    state.roster.mockResolvedValue({ status: { status: 'on_waivers' }, transactionState: null, claimPending: true })
    await act(async () => notifyMemberClaimsChanged('member'))
    expect(state.roster).toHaveBeenCalledTimes(2)
    expect(screen!.root.findByType(PlayerHeader).props.action.label).toBe('View claim')
})

it('reloads the claim after returning from the claim sheet while background reads stay paused', async () => {
    let readable = true
    state.data.canRead = () => readable
    state.data.isCurrentRead = () => readable
    state.roster.mockResolvedValue({ status: { status: 'on_waivers' }, transactionState: null, claimPending: false })
    await act(async () => { screen = create(React.createElement(PlayerDetailScreen)) })
    readable = false
    state.data = { ...state.data, readEpoch: 'claim-sheet' }
    await act(async () => screen!.update(React.createElement(PlayerDetailScreen)))
    state.roster.mockResolvedValue({ status: { status: 'on_waivers' }, transactionState: null, claimPending: true })
    await act(async () => notifyMemberClaimsChanged('member'))
    expect(state.roster).toHaveBeenCalledTimes(1)
    readable = true
    state.data = { ...state.data, readEpoch: 'returned' }
    await act(async () => screen!.update(React.createElement(PlayerDetailScreen)))
    expect(state.roster).toHaveBeenCalledTimes(2)
    expect(screen!.root.findByType(PlayerHeader).props.action.label).toBe('View claim')
})
