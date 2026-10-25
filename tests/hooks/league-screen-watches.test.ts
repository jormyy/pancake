import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'
import type { TableChangeWatch } from '@/lib/realtime'

const watches: TableChangeWatch[] = []
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' }, membershipValidated: true }) }))
vi.mock('@/hooks/use-league-tab-resources', () => ({ useLeagueTabResources: () => ({ mockRooms: [{ id: 'mock' }], invalidateTab: vi.fn() }) }))
vi.mock('@/hooks/use-league-draft-controller', () => ({ useLeagueDraftController: () => ({ activeDraft: { id: 'real' }, fetchActiveDraft: vi.fn() }) }))
vi.mock('@/hooks/use-mock-rooms-controller', () => ({ useMockRoomsController: () => ({}) }))
vi.mock('@/lib/invite-share', () => ({ shareInviteMessage: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    subscribeToTableChanges: (_name: string, options: { watches: TableChangeWatch[] }) => { watches.push(...options.watches); return {} },
    disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('watches room membership and real draft picks without watching snake pick history', async () => {
    const Probe = () => { useLeagueScreenState(); return null }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(watches.map(watch => watch.table)).toContain('draft_picks')
    expect(watches).toContainEqual(expect.objectContaining({ table: 'draft_room_members', filter: 'draft_id=in.(mock,real)' }))
    expect(watches.map(watch => watch.table)).not.toContain('snake_draft_picks')
    await act(async () => renderer.unmount())
})
