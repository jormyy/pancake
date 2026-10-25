import { expect, it, vi } from 'vitest'

vi.mock('./e2e/env.mjs', () => ({ resolvedEnv: () => ({}), requireEnv: () => ({}) }))
const { expectRpcError } = await import('./e2e/multi-team-trade-db-support.mjs')

it('accepts an over-limit error code when the server changes its message', async () => {
  const error = { code: 'PA003', message: 'Your active roster is 1 over the limit of 1.' }
  const client = { rpc: vi.fn().mockResolvedValue({ error }) }
  expect(await expectRpcError(client, 'add_free_agent_atomic', {}, { code: 'PA003' })).toBe(error)
  expect(client.rpc).toHaveBeenCalledWith('add_free_agent_atomic', {})
  await expect(expectRpcError(client, 'add_free_agent_atomic', {}, { code: 'PA005' })).rejects.toThrow()
})

it('keeps message checks for lineup capacity errors', async () => {
  const client = { rpc: vi.fn().mockResolvedValue({ error: { code: 'P0001', message: 'Over the active player limit' } }) }
  await expect(expectRpcError(client, 'set_player_slot_moves_atomic', {}, 'over the active player limit')).resolves.toBeTruthy()
})
