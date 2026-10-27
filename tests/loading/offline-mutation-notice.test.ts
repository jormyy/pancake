import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { OfflineMutationNotice } from '@/components/OfflineMutationNotice'
import { queueMutation } from '@/lib/cache/mutation-queue'
import { setSessionOwner } from '@/lib/session-cache-registry'
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'account' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league' } }) }))
vi.mock('@/constants/tokens', () => ({ textStyles: { meta: {}, body: {} }, spacing: { sm: 8 } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.unstubAllGlobals())
it('announces an action queued after the notice mounts', async () => {
    setSessionOwner('account')
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('window', { addEventListener: vi.fn(), localStorage: { getItem: () => null, setItem: vi.fn() } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(OfflineMutationNotice)) })
    expect(view.toJSON()).toBeNull()
    await act(async () => { void queueMutation({ accountId: 'account', leagueId: 'league', rowIds: ['player'], path: '/waivers/claims', body: '{}' }) })
    expect(JSON.stringify(view.toJSON())).toContain('1 action pending')
    await act(async () => { view.unmount() })
})
