import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { AutoSetModal } from '@/components/AutoSetModal'
import { useLineupActions } from '@/hooks/use-lineup-actions'

const mocks = vi.hoisted(() => ({ autoSetLineup: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/lib/lineup', () => ({ autoSetLineup: mocks.autoSetLineup, planLineupMove: vi.fn(), setPlayerSlotMoves: vi.fn() }))
vi.mock('@/lib/roster', () => ({ activateRosterPlayerWithLineup: vi.fn(), toggleIR: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-16' }))
vi.mock('@/lib/alert', () => ({ confirmAction: vi.fn(), showAlert: vi.fn(), showSuccess: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const owner = { memberId: 'member', leagueId: 'league', seasonId: 'season', weekNumber: 1, seasonYear: 2026 }
let actions!: ReturnType<typeof useLineupActions>
const Probe = ({ authorized }: { authorized: boolean }) => {
    actions = useLineupActions({
        actionContext: authorized ? owner : null,
        actionOwner: owner,
        myLineup: { starters: [], bench: [] },
        league: { roster_size: 10 },
        selectedDate: '2026-10-16',
        startedTeams: new Set(),
        reloadLineup: async () => undefined,
    })
    return React.createElement(AutoSetModal, {
        visible: actions.autoSetModalVisible,
        disabled: actions.autoSetDisabled,
        onClose: () => actions.setAutoSetModalVisible(false),
        onToday: () => { void actions.doAutoSet('2026-10-16') },
        onWholeWeek: () => { void actions.doAutoSet(null) },
        onRestOfSeason: () => { void actions.doAutoSet(null, true) },
    })
}

afterEach(() => vi.clearAllMocks())

it('keeps choices disabled during an authority refresh and permits sheet dismissal', async () => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { authorized: true })) })
    try {
        await act(async () => { actions.handleAutoSet() })
        await act(async () => { renderer.update(React.createElement(Probe, { authorized: false })) })
        expect(renderer.root.findByProps({ title: 'Auto-set lineup' }).props.visible).toBe(true)
        for (const name of ['Auto-set today', 'Auto-set whole week', 'Auto-set rest of season']) {
            expect(renderer.root.findByProps({ accessibilityLabel: name }).props.disabled).toBe(true)
        }
        await act(async () => { await actions.doAutoSet(null) })
        expect(mocks.autoSetLineup).not.toHaveBeenCalled()
        expect(actions.autoSetModalVisible).toBe(true)
        await act(async () => { renderer.root.findByProps({ title: 'Auto-set lineup' }).props.onClose() })
        expect(actions.autoSetModalVisible).toBe(false)
        expect(mocks.autoSetLineup).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { authorized: true })) })
        expect(actions.autoSetModalVisible).toBe(false)
        await act(async () => { actions.handleAutoSet() })
        for (const name of ['Auto-set today', 'Auto-set whole week', 'Auto-set rest of season']) {
            expect(renderer.root.findByProps({ accessibilityLabel: name }).props.disabled).toBe(false)
        }
    } finally { await act(async () => { renderer.unmount() }) }
})

it('closes the sheet when an authorized action starts and blocks overlapping choices', async () => {
    let finish!: (value: null) => void
    mocks.autoSetLineup.mockImplementationOnce(() => new Promise<null>((resolve) => { finish = resolve }))
    let renderer!: ReactTestRenderer
    let pending!: Promise<void>
    await act(async () => { renderer = create(React.createElement(Probe, { authorized: true })) })
    try {
        await act(async () => { actions.handleAutoSet() })
        await act(async () => { pending = actions.doAutoSet(null) })
        expect(actions.autoSetModalVisible).toBe(false)
        expect(mocks.autoSetLineup).toHaveBeenCalledWith('member', 'league', 'season', 1, 2026, null, undefined, undefined)
        await act(async () => { actions.handleAutoSet() })
        expect(actions.autoSetDisabled).toBe(true)
        await act(async () => { await actions.doAutoSet(null, true) })
        expect(mocks.autoSetLineup).toHaveBeenCalledTimes(1)
        expect(actions.autoSetModalVisible).toBe(true)
        await act(async () => { finish(null); await pending })
        expect(actions.autoSetDisabled).toBe(false)
    } finally { await act(async () => { renderer.unmount() }) }
})
