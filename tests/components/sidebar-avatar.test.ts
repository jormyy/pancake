/// <reference path="../../types/react-dom.d.ts" />
import React from 'react'
import Module from 'node:module'
import { WebAppShell } from '@/components/navigation/WebTabShell'
import { updateProfile } from '@/lib/auth'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    userId: 'owner-a', read: vi.fn(), eq: vi.fn(), renders: [] as { owner: string; uri: unknown }[],
}))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', ScrollView: 'ScrollView', Pressable: 'Pressable', Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1440, height: 900 }), StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown[]) => Object.assign({}, ...styles.filter(Boolean)) },
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({ Link: 'Link', Navigator: {}, usePathname: () => '/profile', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: null, currentLeague: null, memberships: [] }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/hooks/use-pending-trade-count', () => ({ usePendingTradeCount: () => 0 }))
vi.mock('@/hooks/use-boot-shell-handoff', () => ({ useBootShellHandoff: () => {} }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn(), draftLoading: false }) }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ update: () => ({ eq: mocks.eq }) }) } }))
vi.mock('@/lib/web-push', () => ({}))
vi.mock('@/lib/auth', async original => ({ ...await original<typeof import('@/lib/auth')>(), getProfile: mocks.read }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/components/Avatar', () => ({ Avatar: (props: { uri: unknown }) => {
    mocks.renders.push({ owner: mocks.userId, uri: props.uri })
    return React.createElement('Avatar', props)
} }))


;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const avatar = () => screen.root.findByType('Avatar' as React.ElementType).props.uri
const mount = async () => { await act(async () => { screen = create(React.createElement(WebAppShell, null, null)) }) }
const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
beforeEach(() => {
    vi.clearAllMocks()
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? 1 : originalLoad.call(moduleLoader, name, ...args))
    mocks.userId = 'owner-a'
    mocks.renders = []
    mocks.read.mockResolvedValue({ avatar_url: 'a.png' })
    mocks.eq.mockResolvedValue({ error: null })
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

describe('sidebar profile authority', () => {
    it('shows a committed avatar without reloading the page or rereading the profile', async () => {
        await mount()
        expect(avatar()).toBe('a.png')
        await act(async () => { await updateProfile('owner-a', { avatar_url: 'new.png' }) })
        expect(avatar()).toBe('new.png')
        expect(mocks.read).toHaveBeenCalledOnce()
    })

    it('never renders the old account avatar while the new profile is pending', async () => {
        await mount()
        const next = deferred<{ avatar_url: string }>()
        mocks.read.mockReturnValueOnce(next.promise)
        mocks.userId = 'owner-b'
        await act(async () => { screen.update(React.createElement(WebAppShell, null, null)) })
        const before = mocks.renders.filter(row => row.owner === 'owner-b').map(row => row.uri)
        await act(async () => { next.resolve({ avatar_url: 'b.png' }); await next.promise })
        expect(before.every(uri => uri === null)).toBe(true)
        expect(avatar()).toBe('b.png')
    })

    it('does not overwrite a newer committed avatar with the earlier initial read', async () => {
        const old = deferred<{ avatar_url: string }>()
        mocks.read.mockReturnValueOnce(old.promise)
        await mount()
        await act(async () => { await updateProfile('owner-a', { avatar_url: 'committed.png' }) })
        await act(async () => { old.resolve({ avatar_url: 'old.png' }); await old.promise })
        expect(avatar()).toBe('committed.png')
    })

    it('ignores failed writes and updates belonging to another account', async () => {
        await mount()
        mocks.eq.mockResolvedValueOnce({ error: new Error('Write refused') })
        await act(async () => { await expect(updateProfile('owner-a', { avatar_url: 'failed.png' })).rejects.toThrow('Write refused') })
        await act(async () => { await updateProfile('owner-b', { avatar_url: 'b.png' }) })
        expect(avatar()).toBe('a.png')
    })
})
