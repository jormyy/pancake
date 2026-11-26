import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import { RosterHoldWarning } from '@/components/roster/RosterHoldWarning'
import { reportPickupError } from '@/lib/pickup'
import { RequestError } from '@/lib/shared/errors'
import { rosterPlayer } from './helpers/fixtures'

vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, subscribeScreenView: () => () => {},
    readScreenView: async () => ({ context: { seasonId: 'season' }, player: { id: 'target', display_name: 'Target', injury_status: null },
        roster: await mocks.read(), priority: 1, clearsAt: null, transactionState: null, members: [{ id: 'member', user_id: 'user' }], claims: [], taxiExitIds: [] }),
}))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))

const mocks = vi.hoisted(() => ({ claim: vi.fn(), read: vi.fn(), alert: vi.fn(), confirm: vi.fn(), checkRosterHold: vi.fn(), retract: vi.fn(), epoch: 0 }))
vi.mock('react-native', () => ({ Image: 'Image', View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', Switch: 'Switch', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ playerId: 'target' }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', roster_size: 2, ir_slots: 1, taxi_slots: 0, status: 'active' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 370 }), PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('Header', null, actions) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: async () => [{ id: 'member', user_id: 'user' }] }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.read }))
vi.mock('@/lib/players', () => ({ getPlayer: async () => ({ id: 'target', display_name: 'Target', injury_status: null }) }))
vi.mock('@/lib/waivers', () => ({ claimProcessDateLabel: () => 'Tomorrow', claimProcessTimeLabel: () => 'tomorrow', getMyWaiverPriority: async () => 1, scheduledClaimLabel: () => 'Tomorrow', getWaiverClearsAt: async () => null, submitWaiverClaim: mocks.claim, checkRosterHold: mocks.checkRosterHold,
    rosterHoldPartnerLabel: (names: string[]) => names.length === 0 ? '' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` }))
vi.mock('@/lib/trades', () => ({ undoTradeAcceptance: mocks.retract }))
vi.mock('@/lib/roster-add-flow', () => ({ loadAddLimitState: async () => null }))
vi.mock('@/lib/format', () => ({ isIneligibleIR: () => false, playerHeadshotUrl: () => null }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: vi.fn(), confirmAction: mocks.confirm }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = { canRead: () => true, canAct: () => true, capture: () => 0, isCurrent: () => true, markReady: vi.fn(), blockActions: vi.fn() }; return { useDraftActivity: () => ({ ...gate, epoch: mocks.epoch }) } })
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: 'IRResolutionModal' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const conflict = {
    tradeId: 'trade-1',
    version: 2,
    holderTeamName: 'Team A',
    partnerTeamNames: ['Team B'],
    canWithdraw: true,
    message: 'Your accepted trade with Team B needs this roster spot. Add a drop or undo your acceptance.',
}
const type = (value: string) => value as React.ElementType
let screen: ReactTestRenderer | undefined
const submit = () => screen!.root.findAllByType(type('Pressable')).find(node => node.props.accessibilityLabel === 'Submit waiver claim')!
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.epoch = 0
    mocks.read.mockResolvedValue([rosterPlayer()])
    mocks.checkRosterHold.mockResolvedValue([])
    mocks.retract.mockResolvedValue(undefined)
    mocks.confirm.mockImplementation((_title, _message, onConfirm) => onConfirm())
})
afterEach(async () => { if (screen) await act(async () => { screen?.unmount() }); screen = undefined })

it('shows each hold conflict inline and disables submit until it clears', async () => {
    mocks.checkRosterHold.mockResolvedValue([conflict])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    expect(JSON.stringify(screen!.toJSON())).toContain(conflict.message)
    expect(submit().props.disabled).toBe(true)
    expect(mocks.checkRosterHold).toHaveBeenCalledWith('member', { addPlayerId: 'target', dropPlayerIds: [], toIr: false, toTaxi: false })
})

it('undoes the acceptance, rechecks, and re-enables submit', async () => {
    mocks.checkRosterHold.mockResolvedValueOnce([conflict]).mockResolvedValue([])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    const undo = screen!.root.findByProps({ accessibilityLabel: 'Undo acceptance of the trade with Team B' })
    await act(async () => { undo.props.onPress() })
    await flush()
    expect(mocks.confirm).toHaveBeenCalledWith('Undo acceptance',
        'Undo your acceptance of the trade with Team B? The offer stays open, other teams keep their answers, and you can accept again.',
        expect.any(Function), 'Undo acceptance')
    expect(mocks.retract).toHaveBeenCalledWith('trade-1', 'member', 2)
    expect(mocks.checkRosterHold).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(screen!.toJSON())).not.toContain(conflict.message)
    expect(JSON.stringify(screen!.toJSON())).toContain('Acceptance undone. Your trade with Team B stays open.')
    expect(submit().props.disabled).toBe(false)
})

it('names every trade partner in the confirmation and the notice', async () => {
    const many = { ...conflict, partnerTeamNames: ['jet lee', 'Justin', 'Castle'] }
    mocks.checkRosterHold.mockResolvedValueOnce([many]).mockResolvedValue([])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    await act(async () => { screen!.root.findByProps({ accessibilityLabel: 'Undo acceptance of the trade with jet lee, Justin, Castle' }).props.onPress() })
    await flush()
    expect(mocks.confirm).toHaveBeenCalledWith('Undo acceptance',
        'Undo your acceptance of the trade with jet lee, Justin and Castle? The offer stays open, other teams keep their answers, and you can accept again.',
        expect.any(Function), 'Undo acceptance')
    expect(JSON.stringify(screen!.toJSON())).toContain('Acceptance undone. Your trade with jet lee, Justin and Castle stays open.')
})

it('shows the server message when the undo fails', async () => {
    mocks.checkRosterHold.mockResolvedValue([conflict])
    mocks.retract.mockRejectedValue(new RequestError('You have not accepted this trade.'))
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    await act(async () => { screen!.root.findByProps({ accessibilityLabel: 'Undo acceptance of the trade with Team B' }).props.onPress() })
    await flush()
    expect(mocks.alert).toHaveBeenCalledWith('Error', 'You have not accepted this trade.')
    expect(JSON.stringify(screen!.toJSON())).not.toContain('Acceptance undone')
})

it('offers the drop chooser as the other remedy', async () => {
    mocks.checkRosterHold.mockResolvedValue([conflict])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    const pick = screen!.root.findByProps({ accessibilityLabel: 'Pick a drop for this pickup' })
    await act(async () => { pick.props.onPress() })
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Select Player A to drop' })).toHaveLength(1)
})

it('omits Undo acceptance when the server rule does not allow it', async () => {
    mocks.checkRosterHold.mockResolvedValue([{ ...conflict, canWithdraw: false, message: 'Your accepted trade with Team B needs this roster spot. Add a drop.' }])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Undo acceptance of the trade with Team B' })).toHaveLength(0)
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Pick a drop for this pickup' }).length).toBeGreaterThan(0)
})

it('renders the warning component with its remedies', async () => {
    const onPickDrop = vi.fn(), onUndoAcceptance = vi.fn()
    await act(async () => {
        screen = create(React.createElement(RosterHoldWarning, { conflicts: [conflict], onPickDrop, onUndoAcceptance }))
    })
    expect(JSON.stringify(screen!.toJSON())).toContain(conflict.message)
    await act(async () => { screen!.root.findByProps({ accessibilityLabel: 'Pick a drop for this pickup' }).props.onPress() })
    await act(async () => { screen!.root.findByProps({ accessibilityLabel: 'Undo acceptance of the trade with Team B' }).props.onPress() })
    expect(onPickDrop).toHaveBeenCalledOnce()
    expect(onUndoAcceptance).toHaveBeenCalledWith(conflict)
})

it('shows the server message for a roster_hold rejection', () => {
    const message = 'Your accepted trade with Team B needs this roster spot. Add a drop or undo your acceptance.'
    reportPickupError(new RequestError(message, { code: 'roster_hold' }))
    expect(mocks.alert).toHaveBeenCalledWith('Roster spot needed', message)
})
