import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rosterPlayer } from '../helpers/fixtures'
import { RULE_CODES } from '@/lib/shared/errors'
import { addFreeAgentOrRequestDrop } from '@/lib/roster-add-flow'

const mocks = vi.hoisted(() => ({ addFreeAgent: vi.fn() }))
vi.mock('@/lib/waivers', () => ({ getPendingWaiverPlayerIdsForSeason: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: vi.fn() }))
vi.mock('@/lib/roster', () => ({ addFreeAgent: mocks.addFreeAgent }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://localhost' }))
vi.mock('@/lib/league', () => ({ getMemberTransactionState: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('roster-full error contract', () => {
    it('opens the drop picker using the RPC code, regardless of message wording', async () => {
        mocks.addFreeAgent.mockRejectedValueOnce({ code: RULE_CODES.rosterFull, message: 'Localized rejection' })
        const active = rosterPlayer()
        const roster = [active, rosterPlayer({ id: 'ir', is_on_ir: true }), rosterPlayer({ id: 'taxi', is_on_taxi: true })]
        await expect(addFreeAgentOrRequestDrop('member', 'league', 'player', roster))
            .resolves.toEqual({ status: 'roster_full', roster })
        expect(mocks.addFreeAgent).toHaveBeenCalledWith('member', 'league', 'player', false)
    })

    it('does not treat other errors containing full as roster capacity errors', async () => {
        const error = { code: 'PA001', message: 'The weekly allowance is full' }
        mocks.addFreeAgent.mockRejectedValueOnce(error)
        await expect(addFreeAgentOrRequestDrop('member', 'league', 'player', []))
            .rejects.toBe(error)
    })
})
