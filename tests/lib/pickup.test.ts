import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addLimitBlockedReason, addLimitSummary, reportPickupError, type AddLimitSource } from '@/lib/pickup'
import { RequestError } from '@/lib/shared/errors'

const alerts = vi.hoisted(() => ({ show: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: alerts.show, confirmAction: alerts.confirm }))

// Midnight ET on Monday 2026-11-02 (EST, UTC-5).
const RESET = '2026-11-02T05:00:00.000Z'
const BEFORE_RESET = Date.parse('2026-11-01T20:00:00.000Z')
const AFTER_RESET = Date.parse('2026-11-02T05:00:01.000Z')
const LABEL = 'Mon, Nov 2 at 12:00 AM ET'
const MESSAGE = `Weekly add limit reached (7/7 adds used this week). Adds reset ${LABEL}.`

const reached = (overrides: Partial<AddLimitSource> = {}): AddLimitSource => ({
    weeklyAddLimit: 7, weeklyAddCount: 7, addLimitResetsAt: RESET, addLimitMessage: MESSAGE, addLimitResetsLabel: LABEL, ...overrides,
})
const open = (overrides: Partial<AddLimitSource> = {}): AddLimitSource => ({
    weeklyAddLimit: 7, weeklyAddCount: 2, addLimitResetsAt: RESET, addLimitMessage: null, addLimitResetsLabel: LABEL, ...overrides,
})

beforeEach(() => { alerts.show.mockReset(); alerts.confirm.mockReset() })

describe('add-limit copy', () => {
    it('explains the block with the server sentence only while the limit is reached', () => {
        expect(addLimitBlockedReason(reached(), BEFORE_RESET)).toBe(MESSAGE)
        expect(addLimitBlockedReason(open(), BEFORE_RESET)).toBeNull()
        expect(addLimitBlockedReason(reached(), AFTER_RESET)).toBeNull()
        expect(addLimitBlockedReason(null)).toBeNull()
    })

    it('summarizes unknown, unlimited, reached, and open states', () => {
        expect(addLimitSummary(null)).toBe('Adds —/—')
        expect(addLimitSummary(reached({ weeklyAddLimit: null, weeklyAddCount: 9 }))).toBe('Adds 9/∞')
        expect(addLimitSummary(reached(), BEFORE_RESET)).toBe(`Adds 7/7 · resets ${LABEL}`)
        expect(addLimitSummary(reached({ addLimitResetsAt: null, addLimitResetsLabel: null }), BEFORE_RESET)).toBe('Adds 7/7 · limit reached')
        expect(addLimitSummary(open(), BEFORE_RESET)).toBe('Adds 2/7')
    })

    it('reports an ended week as such instead of inventing the next count', () => {
        expect(addLimitSummary(reached(), AFTER_RESET)).toBe('Adds 7/7 · new week')
        expect(addLimitSummary(open(), AFTER_RESET)).toBe('Adds 2/7 · new week')
    })
})

describe('reportPickupError', () => {
    it('recognizes the weekly limit by its SQLSTATE from either request path, closes local state, and refreshes the cached week', () => {
        const refresh = vi.fn()
        const onLimitReached = vi.fn()
        reportPickupError(new RequestError(MESSAGE, { code: 'PA001' }), { refresh, onLimitReached })
        reportPickupError({ message: MESSAGE, code: 'PA001' }, { refresh, onLimitReached })
        expect(onLimitReached).toHaveBeenCalledTimes(2)
        expect(refresh).toHaveBeenCalledTimes(2)
        expect(alerts.show).toHaveBeenNthCalledWith(1, 'Weekly add limit reached', MESSAGE)
        expect(alerts.show).toHaveBeenNthCalledWith(2, 'Weekly add limit reached', MESSAGE)
    })

    it('offers the claim flow for a player still on waivers, and only when a claim path exists', () => {
        const error = new RequestError('This player is on waivers - submit a waiver claim instead.', { code: 'PA002' })
        const claim = vi.fn()
        reportPickupError(error, { claim })
        expect(alerts.confirm).toHaveBeenCalledWith(
            'Still on waivers',
            'This player is on waivers - submit a waiver claim instead. Claims are processed on the next waiver run.',
            claim, 'Claim', false,
        )
        expect(alerts.show).not.toHaveBeenCalled()

        reportPickupError(error)
        expect(alerts.show).toHaveBeenCalledWith('Still on waivers', 'This player is on waivers - submit a waiver claim instead.')
    })

    it('opens the IR flow when the server finds IR players who no longer qualify', () => {
        const onIneligibleIr = vi.fn()
        const error = new RequestError('You have ineligible players on IR (Player A). Activate or drop them before adding players.', { code: 'PA005' })
        reportPickupError(error, { onIneligibleIr })
        expect(onIneligibleIr).toHaveBeenCalledWith(error.message)
        expect(alerts.show).not.toHaveBeenCalled()
        reportPickupError(error)
        expect(alerts.show).toHaveBeenCalledWith('Error', error.message)
    })

    it('shows every other failure as it came', () => {
        reportPickupError(new RequestError('Your active roster is full (20 players).', { code: 'PA003' }))
        expect(alerts.show).toHaveBeenCalledWith('Error', 'Your active roster is full (20 players).')
        reportPickupError(new Error('offline'))
        expect(alerts.show).toHaveBeenCalledWith('Error', 'offline')
    })
})
