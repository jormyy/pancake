import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { searchHarness, searchPayload } from '../helpers/search-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = searchHarness()
beforeEach(() => { boundary.read.mockResolvedValue(searchPayload()) })
it('paints a dirty cached page while revalidating it', async () => {
    await h.render(); await h.unmount()
    const next = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    bumpView()
    await h.render()
    expect(h.latest.results.players.map(row => row.id)).toEqual(['player'])
    await act(async () => next.resolve(searchPayload(['fresh'])))
    expect(h.latest.results.players.map(row => row.id)).toEqual(['fresh'])
})
it('rejects an older overlapping result after a member switch', async () => {
    const old = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(searchPayload(['new']))
    await h.render(); await h.render({ member: 'new' })
    await act(async () => old.resolve(searchPayload(['old'])))
    expect(h.latest.results.players.map(row => row.id)).toEqual(['new'])
})
it('retains same-query rows and rejects hidden or former-account results', async () => {
    await h.render(); const prior = h.latest.results.players
    boundary.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => bumpView())
    expect(boundary.read).toHaveBeenCalledOnce()
    expect(h.latest.results.players).toBe(prior)
    boundary.owner = 'other'; h.frames.length = 0; await h.render({ owner: 'other' })
    expect(h.frames.every(frame => frame.results.players.length === 0)).toBe(true)
})
it('revalidates after the ET day changes and retains selected filters', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    await h.render(); await act(async () => { h.latest.position.setValue('PG') })
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z')); await h.render()
    expect(h.latest.position.value).toBe('PG')
    expect(boundary.read.mock.calls.at(-1)?.[0].params.date).toBe('2026-10-28')
})
it('waits for current support before certifying search results', async () => {
    await h.render(); const next = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    await act(async () => bumpView('league', 'inventory'))
    expect(h.latest.results.players.map(row => row.id)).toEqual(['player'])
    expect(h.latest.results.refreshing).toBe(true)
    await act(async () => next.resolve(searchPayload(['free-now'])))
    expect(h.latest.results.players.map(row => row.id)).toEqual(['free-now'])
    expect(h.latest.support?.memberId).toBe('member')
})
it.each(['auto', 'explicit'])('leaves the %s season quiet without a new version', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await h.render()
    if (mode === 'explicit') await act(async () => { h.latest.season.setValue(2026) })
    const reads = boundary.read.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(boundary.read).toHaveBeenCalledTimes(reads)
})
it('replaces the first page when the selected season changes during pagination', async () => {
    boundary.read.mockResolvedValueOnce(searchPayload(['first'], true))
    await h.render(); const old = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(searchPayload(['season']))
    let request!: Promise<void>
    await act(async () => { request = h.latest.results.loadMore() })
    await act(async () => { h.latest.season.setValue(2026) })
    await act(async () => { old.resolve(searchPayload(['old-page'])); await request })
    expect(h.latest.results.players.map(row => row.id)).toEqual(['season'])
})
it('loads rookies one page at a time through the server filter', async () => {
    await h.render(); boundary.read.mockResolvedValueOnce(searchPayload(['rookie'], true)).mockResolvedValueOnce(searchPayload(['last']))
    await act(async () => { h.latest.toggles.setRookiesOnly(true) })
    expect(h.latest.results.players.map(row => row.id)).toEqual(['rookie'])
    await act(async () => { await h.latest.results.loadMore() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ rookiesOnly: true, offset: 1 })
    expect(h.latest.results.players.map(row => row.id)).toEqual(['rookie', 'last'])
})
it('marks an unread empty search pending until its view arrives', async () => {
    const next = held<ReturnType<typeof searchPayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    await h.render()
    expect(h.latest.results.loading).toBe(true)
    expect(h.latest.results.isSnapshot).toBe(true)
    await act(async () => next.resolve(searchPayload([])))
    expect(h.latest.results.loading).toBe(false)
    expect(h.latest.results.isSnapshot).toBe(false)
})
it('does not certify an old empty result while typed text waits for debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boundary.read.mockResolvedValue(searchPayload([])); await h.render()
    await act(async () => { h.latest.search.setQuery('new name') })
    expect(h.latest.results.isSnapshot).toBe(true)
    expect(boundary.read).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(boundary.read.mock.calls.at(-1)?.[0].params.query).toBe('new name')
})
it('exposes a failed next page, keeps existing rows, and retries the current search', async () => {
    boundary.read.mockResolvedValueOnce(searchPayload(['first'], true)).mockRejectedValueOnce(new Error('page unavailable')).mockResolvedValue(searchPayload(['retried']))
    await h.render(); await act(async () => { await h.latest.results.loadMore() })
    expect(h.latest.results.error?.message).toBe('page unavailable')
    expect(h.latest.results.players.map(row => row.id)).toEqual(['first'])
    await act(async () => { h.latest.results.retry() })
    expect(h.latest.results.error).toBeNull()
    expect(h.latest.results.players.map(row => row.id)).toEqual(['retried'])
})
it('sends availability and playing filters to the server on every page', async () => {
    await h.render(); boundary.read.mockResolvedValue(searchPayload(['free'], true))
    await act(async () => { h.latest.playing.setValue('today'); h.latest.availabilityFilter.setValue('free_agents') })
    await act(async () => { await h.latest.results.loadMore() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toMatchObject({ playing: 'today', availability: 'free_agents', offset: 1 })
})
it('surfaces a required schedule failure and retries the complete filtered view', async () => {
    await h.render(); boundary.read.mockRejectedValueOnce(new Error('schedule unavailable'))
    await act(async () => { h.latest.playing.setValue('today') })
    expect(h.latest.results.error?.message).toBe('schedule unavailable')
    expect(h.latest.results.isSnapshot).toBe(true)
    await act(async () => { h.latest.results.retry() })
    expect(h.latest.results.error).toBeNull()
    expect(boundary.read.mock.calls.at(-1)?.[0].params.playing).toBe('today')
})
it('finds a newly freed player after an ownership version', async () => {
    boundary.read.mockResolvedValueOnce(searchPayload([])).mockResolvedValue(searchPayload(['free-now']))
    await h.render(); await act(async () => bumpView('league', 'roster'))
    expect(h.latest.results.players.map(row => row.id)).toEqual(['free-now'])
})
it.each(['position', 'health', 'teams', 'sort'])('retains the %s filter through a reconnect', async filter => {
    await h.render()
    await act(async () => { if (filter === 'position') h.latest.position.setValue('C'); if (filter === 'health') h.latest.health.setValue('healthy'); if (filter === 'teams') h.latest.teamPicker.setSelectedTeams(['BOS']); if (filter === 'sort') h.latest.sort.setDir('asc') })
    const params = boundary.read.mock.calls.at(-1)?.[0].params
    boundary.online = false; await h.render(); boundary.online = true; await h.render()
    await act(async () => { window.dispatchEvent(new Event('online')); bumpView() })
    expect(boundary.read.mock.calls.at(-1)?.[0].params).toEqual(params)
})
