import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rosterPlayer } from '../helpers/fixtures'
import { RULE_CODES } from '@/lib/shared/errors'
import { addFreeAgentOrRequestDrop } from '@/lib/roster-add-flow'

const mocks = vi.hoisted(() => ({ addFreeAgent: vi.fn() }))
vi.mock('@/lib/roster', () => ({ addFreeAgent: mocks.addFreeAgent }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://localhost' }))
vi.mock('@/lib/league', () => ({ getMemberTransactionState: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('roster-full error contract', () => {
    it('opens the drop picker using the RPC code, regardless of message wording', async () => {
        const sql = await readFile('supabase/sql/functions/by-name/public/add_free_agent_atomic.sql', 'utf8')
        const code = sql.match(/RAISE EXCEPTION 'Your active roster is full[^;]+ERRCODE\s*=\s*'([^']+)'/)?.[1]
        expect(code).toBe(RULE_CODES.rosterFull)
        mocks.addFreeAgent.mockRejectedValueOnce({ code, message: 'Localized rejection' })
        const active = rosterPlayer()
        const roster = [active, rosterPlayer({ id: 'ir', is_on_ir: true }), rosterPlayer({ id: 'taxi', is_on_taxi: true })]
        await expect(addFreeAgentOrRequestDrop('member', 'league', 'player', roster))
            .resolves.toEqual({ status: 'roster_full', activeRoster: [active] })
        expect(mocks.addFreeAgent).toHaveBeenCalledWith('member', 'league', 'player')
    })

    it('does not treat other errors containing full as roster capacity errors', async () => {
        const error = { code: 'PA001', message: 'The weekly allowance is full' }
        mocks.addFreeAgent.mockRejectedValueOnce(error)
        await expect(addFreeAgentOrRequestDrop('member', 'league', 'player', []))
            .rejects.toBe(error)
    })
})
