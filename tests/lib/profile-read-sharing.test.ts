import { beforeEach, expect, it, vi } from 'vitest'
import { getProfile, updateProfile, suspendProfileRead } from '@/lib/auth'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const boundary = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({
    select: () => ({ eq: () => ({ single: boundary.read }) }),
    update: () => ({ eq: boundary.write }),
}) } }))
vi.mock('@/lib/web-push', () => ({}))
const profile = { id: 'a', avatar_url: 'a.png', display_name: 'A' }
beforeEach(() => {
    vi.clearAllMocks()
    clearSessionCaches()
    setSessionOwner('a')
    boundary.read.mockResolvedValue({ data: profile, error: null })
    boundary.write.mockResolvedValue({ error: null })
})

it('shares pending and recently completed reads for the same owner', async () => {
    const [first, second] = await Promise.all([getProfile('a'), getProfile('a')])
    expect(first).toEqual(profile)
    expect(second).toEqual(profile)
    expect(await getProfile('a')).toEqual(profile)
    expect(boundary.read).toHaveBeenCalledOnce()
})

it('clears profile data and pending admission when the session changes', async () => {
    let release!: (result: { data: typeof profile; error: null }) => void
    boundary.read.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = getProfile('a')
    setSessionOwner('b')
    await getProfile('b')
    release({ data: profile, error: null })
    await old
    setSessionOwner('a')
    await getProfile('a')
    expect(boundary.read).toHaveBeenCalledTimes(3)
})

it('preserves a committed patch when an older shared read settles', async () => {
    let release!: (result: { data: typeof profile; error: null }) => void
    boundary.read.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = getProfile('a')
    await updateProfile('a', { avatar_url: 'new.png' })
    release({ data: profile, error: null })
    expect((await old).avatar_url).toBe('new.png')
    expect((await getProfile('a')).avatar_url).toBe('new.png')
})


it('lets resumption read fresh data before the suspended response settles', async () => {
    let release!: (result: { data: typeof profile; error: null }) => void
    boundary.read.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = getProfile('a')
    suspendProfileRead('a')
    boundary.read.mockResolvedValue({ data: { ...profile, avatar_url: 'fresh.png' }, error: null })
    expect((await getProfile('a', { force: true })).avatar_url).toBe('fresh.png')
    release({ data: profile, error: null })
    await old
    expect((await getProfile('a')).avatar_url).toBe('fresh.png')
})

it('does not pin a local patch over a later authoritative change', async () => {
    await getProfile('a')
    await updateProfile('a', { avatar_url: 'local.png' })
    boundary.read.mockResolvedValue({ data: { ...profile, avatar_url: 'other-device.png' }, error: null })
    expect((await getProfile('a', { force: true })).avatar_url).toBe('other-device.png')
})
