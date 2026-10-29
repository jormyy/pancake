import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { rpc: vi.fn() }
const source = readFileSync('supabase/functions/_shared/notificationDraft.ts', 'utf8')
const loaded: { queueRookiePickNotification?: (...args: string[]) => Promise<void> } = {}
runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, {
  exports: loaded,
  require: (name: string) => {
    if (name !== './supabase.ts') throw new Error(`Unexpected module: ${name}`)
    return { supabase: { rpc: state.rpc } }
  },
})
const queueRookiePickNotification = loaded.queueRookiePickNotification!

describe('rookie pick enqueue', () => {
  beforeEach(() => state.rpc.mockReset())

  it('passes the complete pick identity to the database enqueue path', async () => {
    state.rpc.mockResolvedValue({ error: null })
    await queueRookiePickNotification('draft', 'member', 'player', 'pick')
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('enqueue_rookie_pick_notification', {
      p_draft_id: 'draft', p_member_id: 'member', p_player_id: 'player', p_pick_id: 'pick',
    })
  })

  it('surfaces database failures to the caller', async () => {
    const error = { message: 'enqueue rejected' }
    state.rpc.mockResolvedValue({ error })
    await expect(queueRookiePickNotification('draft', 'member', 'player', 'pick')).rejects.toBe(error)
  })
})
