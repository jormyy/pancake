import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DailyWaivers } from '@/components/home/DailyWaivers'
import type { WaiverClaim } from '@/lib/waivers'

const state = vi.hoisted(() => ({
    data: null as null | { claims: Partial<WaiverClaim>[]; transactionState: { faabBalance: number } | null; waiverPriority: number | null },
    error: null as Error | null, online: true, validated: true, memberId: 'member',
    push: vi.fn(), refresh: vi.fn(), scope: null as null | Record<string, unknown>, enabled: false,
}))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: state.memberId }, currentLeague: { id: 'league', waiver_mode: 'faab' }, membershipValidated: state.validated, online: state.online }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: (scope: Record<string, unknown> | null, enabled: boolean) => {
    state.scope = scope; state.enabled = enabled
    return { data: state.data, error: state.error, refresh: state.refresh }
} }))
vi.mock('@/lib/waivers', () => ({
    claimProcessDateLabel: () => 'Wed, Oct 28 · 12:00 AM PT', scheduledClaimLabel: (day: string) => `${day} · 12:00 AM PT`, scheduledClaimRunAt: (day: string) => new Date(`${day}T07:00:00Z`),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const mount = async () => { await act(async () => { screen = create(React.createElement(DailyWaivers)) }) }
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).join(' ')
beforeEach(() => { vi.clearAllMocks(); state.data = null; state.error = null; state.online = true; state.validated = true; state.memberId = 'member' })
afterEach(async () => { await act(async () => screen?.unmount()) })

it('does not report zero pending claims before a successful read', async () => {
    await mount()
    expect(text()).toContain('Claims unavailable')
    expect(text()).not.toContain('0 pending claims')
    expect(text()).toContain('FAAB left $—')
})

it('shows pending claims, the saved run date, and available FAAB', async () => {
    state.data = { claims: [{ id: 'claim', status: 'pending', playerId: 'player', playerName: 'Test Player', processDate: '2099-10-28' }], transactionState: { faabBalance: 73 }, waiverPriority: 2 }
    await mount()
    expect(text()).toContain('1 pending claim')
    expect(text()).toContain('2099-10-28 · 12:00 AM PT')
    expect(text()).toContain('FAAB left $73')
    await act(async () => screen.root.findByProps({ title: 'Edit claim: Test Player' }).props.onPress())
    expect(state.push).toHaveBeenCalledWith({ pathname: '/(modals)/claim-player', params: { playerId: 'player', claimId: 'claim' } })
})

it('loads the current member and scopes the resource to its owner', async () => {
    await mount()
    expect(state.scope).toMatchObject({ screen: 'roster', accountId: 'owner', memberId: 'member', leagueId: 'league' })
    expect(state.enabled).toBe(true)
    state.memberId = 'other'
    await act(async () => screen.update(React.createElement(DailyWaivers)))
    expect(state.scope).toMatchObject({ accountId: 'owner', memberId: 'other', leagueId: 'league' })
    state.validated = false
    await act(async () => screen.update(React.createElement(DailyWaivers)))
    expect(state.enabled).toBe(false)
})

it('opens discovery and claim management in one tap and offers retry after failure', async () => {
    state.error = new Error('Read failed')
    await mount()
    for (const [title, href] of [['Find a player to claim', '/players?section=players'], ['Manage claims', '/players?section=waivers']]) {
        await act(async () => screen.root.findByProps({ title }).props.onPress())
        expect(state.push).toHaveBeenLastCalledWith(href)
    }
    await act(async () => screen.root.findByProps({ title: 'Retry waivers' }).props.onPress())
    expect(state.refresh).toHaveBeenCalledOnce()
})

it('shows due claims and the offline state without inventing another deadline', async () => {
    state.online = false
    state.data = { claims: [{ status: 'pending', processDate: '2001-01-01' }], transactionState: null, waiverPriority: null }
    await mount()
    expect(text()).toContain('Claims are due for processing')
    expect(text()).toContain('Offline. Connect to update claims.')
})
