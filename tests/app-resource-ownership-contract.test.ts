import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import BracketScreen from '@/app/(modals)/bracket'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({
    user: { id: 'actor' }, member: { id: 'member' }, league: { id: 'league', roster_size: 1, waiver_mode: 'faab' },
    visible: true, online: true,
    player: vi.fn(), roster: vi.fn(), members: vi.fn(), claim: vi.fn(), bracket: vi.fn(),
    back: vi.fn(), replace: vi.fn(),
}))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView',
    Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 1200, height: 900 }),
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('expo-router', () => ({
    Stack: { Screen: () => null }, useLocalSearchParams: () => ({ playerId: 'target' }),
    useRouter: () => ({ replace: state.replace }),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: state.user }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: state.member, currentLeague: state.league }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => state.online }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => state.back }))
vi.mock('@/components/ui', () => ({
    LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 1200 }),
    PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('Header', null, actions),
}))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: state.members }))
vi.mock('@/lib/roster', () => ({ getRoster: state.roster }))
vi.mock('@/lib/players', () => ({ getPlayer: state.player }))
vi.mock('@/lib/bracket', () => ({ getPlayoffBracket: state.bracket }))
vi.mock('@/lib/waivers', () => ({
    claimProcessDateLabel: () => 'Tomorrow', claimProcessTimeLabel: () => 'tomorrow',
    getMyWaiverPriority: async () => 1, getWaiverClearsAt: async () => null, submitWaiverClaim: state.claim,
}))
vi.mock('@/lib/roster-add-flow', () => ({ loadAddLimitState: async () => ({ weeklyAddCount: 0, weeklyAddLimit: 7, waiverMode: 'faab', faabBalance: 100 }) }))
vi.mock('@/lib/format', () => ({ isIneligibleIR: () => false, playerHeadshotUrl: () => null, formatPoints: String }))
vi.mock('@/lib/pickup', () => ({ addLimitSummary: () => '', reportPickupError: vi.fn() }))
vi.mock('@/hooks/use-add-limit-gate', () => ({ useAddLimitGate: () => ({ addBlockedReason: null, explainBlock: () => false }) }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), showSuccess: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('route resource ownership contracts', () => {
    it('gates lineup data and row actions by the current member and league', () => {
        const lineup = source('app/(modals)/lineup.tsx')
        expect(lineup).toContain('const ownsLineup = dataOwnerKey === ownerKey')
        expect(lineup).toContain('const visibleCtx = ownsLineup ? ctx : null')
        expect(lineup).toContain('generation === sessionGeneration()')
        expect(lineup).toContain('readStoredAuthState().session?.user.id === userId')
        expect(lineup).toContain('disabled={readOnly || autoSetting || saving || lineupRefreshing || lineupLoading}')
    })

    it('cancels roster confirmations and action effects when membership changes', () => {
        const roster = source('app/(tabs)/roster.tsx')
        expect(roster).toContain("const ownerIdentity = current?.id && leagueId ? `${current.id}:${leagueId}` : null")
        expect(roster).toContain('actionGenerationRef.current += 1')
        expect(roster.match(/if \(!isCurrentAction\(generation, identity\)\) return/g)?.length).toBeGreaterThanOrEqual(5)
        expect(roster).toContain('rosterRecoveryRunnerRef.current = createRosterRecoveryRunner()')
    })

    it('keys player roster status and destructive action state to the route owner', () => {
        const player = source('app/player/[id].tsx')
        expect(player).toContain('rosterStatusResource.ownerIdentity === ownerIdentity')
        expect(player).toContain('if (!isCurrent(generation, requestedOwner)) return')
        // The pickup flow lives in useQuickAdd, keyed to member + league; the page only feeds it and reads its state.
        expect(player).toContain('onChanged: loadRosterStatus,')
        expect(player).toContain('visible={quickAdd.dropPickerPlayer !== null}')
        expect(player).not.toContain('loadRosterAddGate')
        expect(player).not.toContain('tryAddFreeAgent/push/id are stable enough')
    })

})

describe('mounted route resource ownership', () => {
    let screen: ReactTestRenderer | undefined
    beforeEach(() => {
        vi.clearAllMocks()
        setSessionOwner('actor')
        state.user = { id: 'actor' }
        state.member = { id: 'member' }
        state.league = { id: 'league', roster_size: 1, waiver_mode: 'faab' }
        state.visible = true
        state.online = true
        const page = new EventTarget()
        Object.defineProperty(page, 'visibilityState', { get: () => state.visible ? 'visible' : 'hidden' })
        vi.stubGlobal('document', page)
        vi.stubGlobal('window', new EventTarget())
        vi.stubGlobal('navigator', { get onLine() { return state.online } })
        state.player.mockResolvedValue({ id: 'target', display_name: 'Claim target', nba_team: 'BOS', position: 'PG' })
        state.roster.mockResolvedValue([{ id: 'roster-drop', is_on_ir: false, is_on_taxi: false,
            players: { id: 'drop', display_name: 'Drop candidate', nba_team: 'LAL', position: 'PG' } }])
        state.members.mockImplementation(async () => [{ id: state.member.id, user_id: state.user.id }])
        state.claim.mockResolvedValue(undefined)
        state.bracket.mockResolvedValue(null)
    })
    afterEach(async () => {
        await act(async () => { screen?.unmount() })
        screen = undefined
        vi.unstubAllGlobals()
    })

    const control = (label: string) => screen!.root.find(node => node.props.accessibilityLabel === label)
    const rendered = () => JSON.stringify(screen!.toJSON())

    it('preserves an unsent waiver bid and drop choice across same-owner membership refreshes', async () => {
        await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
        await act(async () => {
            control('FAAB bid amount').props.onChangeText('37')
            control('Select Drop candidate to drop').props.onPress()
        })
        state.member = { ...state.member }
        state.user = { ...state.user }
        state.league = { ...state.league }
        await act(async () => { screen!.update(React.createElement(ClaimPlayerScreen)) })
        expect(state.player).toHaveBeenCalledOnce()
        expect(control('FAAB bid amount').props.value).toBe('37')
        expect(control('Select Drop candidate to drop').props.accessibilityState.selected).toBe(true)
        expect(control('Submit waiver claim').props.disabled).toBe(false)
        expect(state.claim).not.toHaveBeenCalled()
        await act(async () => { await control('Submit waiver claim').props.onPress() })
        expect(state.claim).toHaveBeenCalledWith('member', 'league', 'target', 'drop', { bidAmount: 37 })
    })

    it('keeps the unsent waiver form through one offline resume read', async () => {
        await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
        await act(async () => {
            control('FAAB bid amount').props.onChangeText('37')
            control('Select Drop candidate to drop').props.onPress()
            state.online = false
            window.dispatchEvent(new Event('offline'))
        })
        expect(state.player).toHaveBeenCalledOnce()
        expect(control('Submit waiver claim').props.disabled).toBe(true)
        await act(async () => { state.online = true; window.dispatchEvent(new Event('online')) })
        expect(state.player).toHaveBeenCalledTimes(2)
        expect(control('FAAB bid amount').props.value).toBe('37')
        expect(control('Select Drop candidate to drop').props.accessibilityState.selected).toBe(true)
        expect(control('Submit waiver claim').props.disabled).toBe(false)
        expect(state.claim).not.toHaveBeenCalled()
    })

    const bracket = (team: string) => ({
        quarterfinals: [], semifinals: [], final: null,
        rounds: [{ number: 1, label: 'Championship', matchups: [{
            id: team, homeId: 'home', awayId: 'away', homeName: team, awayName: 'Opponent',
            homePoints: 100, awayPoints: 90, isFinalized: true, winnerId: 'home', weekNumber: 20,
        }] }],
    })

    it.each(['member', 'league'] as const)('rejects late playoff bracket data after the selected %s changes', async changed => {
        let resolveOld!: (value: ReturnType<typeof bracket>) => void
        state.bracket.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
        await act(async () => { screen = create(React.createElement(BracketScreen)) })
        if (changed === 'member') state.member = { id: 'replacement' }
        else state.league = { ...state.league, id: 'replacement' }
        state.bracket.mockResolvedValue(bracket('Current team'))
        await act(async () => { screen!.update(React.createElement(BracketScreen)) })
        expect(state.bracket).toHaveBeenCalledTimes(2)
        expect(state.bracket).toHaveBeenLastCalledWith(state.league.id)
        expect(rendered()).toContain('Current team')
        await act(async () => { resolveOld(bracket('Previous team')) })
        expect(rendered()).toContain('Current team')
        expect(rendered()).not.toContain('Previous team')

        if (changed === 'member') state.member = { id: 'third' }
        else state.league = { ...state.league, id: 'third' }
        state.bracket.mockReturnValue(new Promise(() => {}))
        await act(async () => { screen!.update(React.createElement(BracketScreen)) })
        expect(rendered()).not.toContain('Current team')
        expect(screen!.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(1)
    })

    it('rejects a hidden bracket reply and reads once when visible again', async () => {
        let resolveOld!: (value: ReturnType<typeof bracket>) => void
        state.bracket.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
        await act(async () => { screen = create(React.createElement(BracketScreen)) })
        await act(async () => { state.visible = false; document.dispatchEvent(new Event('visibilitychange')) })
        await act(async () => { resolveOld(bracket('Hidden reply')) })
        expect(rendered()).not.toContain('Hidden reply')
        expect(state.bracket).toHaveBeenCalledOnce()
        state.bracket.mockResolvedValue(bracket('Visible reply'))
        await act(async () => { state.visible = true; document.dispatchEvent(new Event('visibilitychange')) })
        expect(state.bracket).toHaveBeenCalledTimes(2)
        expect(rendered()).toContain('Visible reply')
    })
})
