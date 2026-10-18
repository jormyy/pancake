import { beforeEach, expect, it, vi } from 'vitest'
import { acquireJoinableDraft, getJoinableDraft } from '@/lib/draft'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const boundary = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: boundary.from } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))

type Response = { data: unknown; error: Error | null }
let reads: { table: string; resolve: (response: Response) => void }[]

beforeEach(() => {
    clearSessionCaches()
    setSessionOwner('actor')
    reads = []
    boundary.from.mockImplementation((table: string) => {
        const chain = {
            select: () => chain, eq: () => chain, in: () => chain,
            order: () => chain, limit: () => chain,
            maybeSingle: () => new Promise<Response>(resolve => { reads.push({ table, resolve }) }),
        }
        return chain
    })
})

const flush = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve() }

it('rejects an inactive read before its first query', async () => {
    const options = { includeCompletedRookie: true, canRead: () => false }
    const result = getJoinableDraft('league', options).catch(error => error)
    expect(reads).toHaveLength(0)
    expect(await result).toEqual(new Error('Read is no longer active'))
})

it('stops before league fallback when admission expires during the active lookup', async () => {
    let active = true
    const options = { includeCompletedRookie: true, canRead: () => active }
    const result = getJoinableDraft('league', options).catch(error => error)
    active = false
    reads[0].resolve({ data: null, error: null })
    await flush()
    expect(reads.map(read => read.table)).toEqual(['drafts'])
    expect(await result).toEqual(new Error('Read is no longer active'))
})

it('stops before completed rookie fallback when admission expires during the league lookup', async () => {
    let active = true
    const options = { includeCompletedRookie: true, canRead: () => active }
    const result = getJoinableDraft('league', options).catch(error => error)
    reads[0].resolve({ data: null, error: null })
    await flush()
    active = false
    reads[1].resolve({ data: { status: 'drafting' }, error: null })
    await flush()
    expect(reads.map(read => read.table)).toEqual(['drafts', 'leagues'])
    expect(await result).toEqual(new Error('Read is no longer active'))
})

it('keeps the active-only default for existing callers', async () => {
    const result = getJoinableDraft('league')
    reads[0].resolve({ data: null, error: null })
    expect(await result).toBeNull()
    expect(reads.map(read => read.table)).toEqual(['drafts'])
})

it('keeps the completed rookie fallback for existing callers', async () => {
    const result = getJoinableDraft('league', { includeCompletedRookie: true })
    reads[0].resolve({ data: null, error: null })
    await flush()
    reads[1].resolve({ data: { status: 'drafting' }, error: null })
    await flush()
    reads[2].resolve({ data: { id: 'rookie', draft_type: 'snake', status: 'completed' }, error: null })
    expect(await result).toMatchObject({ id: 'rookie', draftType: 'snake', status: 'completed' })
    expect(reads.map(read => read.table)).toEqual(['drafts', 'leagues', 'drafts'])
})

const sharedOptions = { memberId: 'member', includeCompletedRookie: true, canRead: () => true }

it('releases one reader without cancelling another reader of the same identity', async () => {
    const first = acquireJoinableDraft('league', sharedOptions)
    const second = acquireJoinableDraft('league', sharedOptions)
    const firstResult = first.promise.catch(error => error)
    expect(reads).toHaveLength(1)
    first.release()
    first.release()
    reads[0].resolve({ data: { id: 'auction', draft_type: 'auction' }, error: null })
    expect(await second.promise).toMatchObject({ id: 'auction' })
    expect(await firstResult).toEqual(new Error('Read is no longer active'))
})

it('does not let an old completion or release evict the new pending read', async () => {
    const old = acquireJoinableDraft('league', sharedOptions)
    const oldResult = old.promise.catch(error => error)
    old.release()
    const current = acquireJoinableDraft('league', sharedOptions)
    reads[0].resolve({ data: null, error: null })
    expect(await oldResult).toEqual(new Error('Read is no longer active'))
    old.release()
    const joined = acquireJoinableDraft('league', sharedOptions)
    expect(reads.map(read => read.table)).toEqual(['drafts', 'drafts'])
    reads[1].resolve({ data: { id: 'current' }, error: null })
    expect(await current.promise).toMatchObject({ id: 'current' })
    expect(await joined.promise).toMatchObject({ id: 'current' })
})

it('prunes suspended readers before joining a pending read', async () => {
    let active = true
    const old = acquireJoinableDraft('league', { ...sharedOptions, canRead: () => active })
    const oldResult = old.promise.catch(error => error)
    active = false
    const current = acquireJoinableDraft('league', sharedOptions)
    expect(reads).toHaveLength(2)
    active = true
    reads[0].resolve({ data: null, error: null })
    expect(await oldResult).toEqual(new Error('Read is no longer active'))
    expect(reads).toHaveLength(2)
    reads[1].resolve({ data: { id: 'current' }, error: null })
    expect(await current.promise).toMatchObject({ id: 'current' })
})

it('isolates member, league, and fallback policy within a session', async () => {
    const requests = [
        acquireJoinableDraft('league', sharedOptions),
        acquireJoinableDraft('league', { ...sharedOptions, memberId: 'other-member' }),
        acquireJoinableDraft('other-league', sharedOptions),
        acquireJoinableDraft('league', { ...sharedOptions, includeCompletedRookie: false }),
    ]
    expect(reads).toHaveLength(4)
    reads.forEach((read, index) => read.resolve({ data: { id: `draft-${index}` }, error: null }))
    expect((await Promise.all(requests.map(read => read.promise))).map(draft => draft?.id))
        .toEqual(['draft-0', 'draft-1', 'draft-2', 'draft-3'])
})

it.each(['replacement', null])('releases a prior session before rerender when its actor becomes %s', async actor => {
    const old = acquireJoinableDraft('league', sharedOptions)
    const oldResult = old.promise.catch(error => error)
    setSessionOwner(actor)
    setSessionOwner('actor')
    const current = acquireJoinableDraft('league', sharedOptions)
    reads[0].resolve({ data: null, error: null })
    expect(await oldResult).toEqual(new Error('Read is no longer active'))
    expect(reads.map(read => read.table)).toEqual(['drafts', 'drafts'])
    reads[1].resolve({ data: { id: 'new-session' }, error: null })
    expect(await current.promise).toMatchObject({ id: 'new-session' })
})

it('evicts a shared failure so a subsequent read can retry', async () => {
    const first = acquireJoinableDraft('league', sharedOptions)
    const second = acquireJoinableDraft('league', sharedOptions)
    const results = Promise.allSettled([first.promise, second.promise])
    reads[0].resolve({ data: null, error: new Error('unavailable') })
    expect(await results).toEqual([
        { status: 'rejected', reason: new Error('unavailable') },
        { status: 'rejected', reason: new Error('unavailable') },
    ])
    const retry = acquireJoinableDraft('league', sharedOptions)
    expect(reads).toHaveLength(2)
    reads[1].resolve({ data: { id: 'recovered' }, error: null })
    expect(await retry.promise).toMatchObject({ id: 'recovered' })
})
