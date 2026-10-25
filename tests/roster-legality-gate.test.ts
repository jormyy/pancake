import { expect, it, vi } from 'vitest'
import { loadRosterAddGate } from '@/lib/roster-add-flow'
import { reportPickupError } from '@/lib/pickup'
import { rosterPlayer } from './helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ getRoster: state.roster }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/alert', () => ({ showAlert: state.alert, confirmAction: vi.fn() }))

it('detects ineligible taxi beside IR and active overflow before an acquisition', async () => {
    const taxi = rosterPlayer({ id: 'taxi', is_on_taxi: true })
    taxi.players = { ...taxi.players, years_exp: 2, career_regular_season_games: 65 }
    const ir = rosterPlayer({ id: 'ir', is_on_ir: true })
    ir.players = { ...ir.players, injury_status: null }
    state.roster.mockResolvedValue([taxi, ir, rosterPlayer({ id: 'active' }), rosterPlayer({ id: 'excess' })])
    const gate = await loadRosterAddGate('member', 'league', undefined, 1)
    expect(gate.ineligible.map(player => player.id)).toEqual(['taxi', 'ir'])
    expect(gate.problems.map(problem => problem.kind)).toEqual(['taxi', 'ir', 'over_limit'])
})
it('opens the existing resolution flow for a stale-client taxi error', () => {
    const open = vi.fn()
    reportPickupError({ code: 'PA009', message: 'Player A no longer qualifies for taxi.' }, { onIneligibleIr: open })
    expect(open).toHaveBeenCalledWith('Player A no longer qualifies for taxi.')
    expect(state.alert).not.toHaveBeenCalled()
})
