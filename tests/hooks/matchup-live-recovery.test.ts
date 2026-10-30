import { boundary, bumpView } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { cachedScreenView, saveScreenView } from '@/lib/cache/screen-cache'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
const games = (status = 'InProgress', game_time = '2026-10-30T00:00:00Z') => [{ id: 'game', status, game_time, game_date: '2026-10-29' }]
const payload = (points = 200, slate = games()) => ({ ...homePayload(undefined, points), todaysGames: slate })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const changedServer = () => {
    boundary.server = { version: '2', changes: [{ version: '2', topic: 'score', scope: { tables: ['matchup_totals'] }, created_at: '2026-10-30T01:00:00Z' }] }
    boundary.read.mockResolvedValue(payload(12))
}
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime('2026-10-30T01:00:00Z')
    setLeagueChangesConnected('league', false)
    boundary.read.mockResolvedValue(payload())
})
const connected = () => {
    notifyLeagueChange('league', { topic: 'version', version: '1', changes: [], scopes: null })
    setLeagueChangesConnected('league', true)
}

it('recovers a silently stale connected matchup through HTTP within twenty seconds', async () => {
    await h.render(); connected(); changedServer()
    await advance(19_999)
    expect(boundary.checks).not.toHaveBeenCalled()
    expect(h.latest.matchup?.myPoints).toBe(200)
    await advance(251)
    expect(boundary.checks).toHaveBeenCalledOnce()
    expect(h.latest.matchup?.myPoints).toBe(12)
    expect(boundary.read).toHaveBeenCalledTimes(2)
})

it('keeps a twenty-second version guard while connected without rereading unchanged views', async () => {
    await h.render(); connected()
    await advance(60_000)
    expect(boundary.checks).toHaveBeenCalledTimes(3)
    expect(boundary.read).toHaveBeenCalledOnce()
})

it.each(['score', 'stat', 'game', 'player_stats'] as const)('refetches a %s hint without a version packet within two seconds', async topic => {
    await h.render(); connected()
    boundary.read.mockResolvedValue(payload(12))
    await act(async () => { notifyLeagueChange('league', { topic, scopes: null }) })
    await advance(250)
    expect(h.latest.matchup?.myPoints).toBe(12)
    expect(boundary.checks).not.toHaveBeenCalled()
    expect(boundary.read).toHaveBeenCalledTimes(2)
})

it('coalesces score, stat, and version hints without invalidating saved Players', async () => {
    await h.render(); connected()
    const scope = { accountId: 'account', leagueId: 'league', screen: 'players' as const }
    saveScreenView(scope, { players: ['saved'] }, '1')
    boundary.read.mockResolvedValue(payload(12))
    await act(async () => {
        notifyLeagueChange('league', { topic: 'score', scopes: null })
        notifyLeagueChange('league', { topic: 'stat', scopes: null })
        bumpView('league', 'score', ['standings_current'])
    })
    await advance(250)
    expect(boundary.read).toHaveBeenCalledTimes(2)
    expect(cachedScreenView(scope)?.dirty).toBe(false)
    expect(h.latest.matchup?.myPoints).toBe(12)
})

it.each(['visibilitychange', 'focus', 'pageshow', 'online'])('bypasses connected cache authority on %s after a silent gap', async event => {
    await h.render(); connected(); changedServer()
    await act(async () => { (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)) })
    await advance(250)
    expect(boundary.checks).toHaveBeenCalledOnce()
    expect(h.latest.matchup?.myPoints).toBe(12)
})

it('stops live checks while hidden and catches up immediately on return', async () => {
    await h.render(); connected()
    boundary.hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    changedServer()
    await advance(120_000)
    expect(boundary.checks).not.toHaveBeenCalled()
    boundary.hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await advance(250)
    expect(h.latest.matchup?.myPoints).toBe(12)
})

it('does no recurring version checks with a final or empty slate', async () => {
    boundary.read.mockResolvedValue(payload(200, games('Final')))
    await h.render(); connected()
    await advance(10 * 60_000)
    expect(boundary.checks).not.toHaveBeenCalled()
    expect(boundary.read).toHaveBeenCalledOnce()
})

it('wakes at scheduled tipoff without polling throughout the quiet lead-in', async () => {
    boundary.read.mockResolvedValue(payload(200, games('Scheduled', '2026-10-30T01:01:00Z')))
    await h.render(); connected()
    await advance(59_999)
    expect(boundary.checks).not.toHaveBeenCalled()
    changedServer()
    await advance(251)
    expect(boundary.checks).toHaveBeenCalledOnce()
    expect(h.latest.matchup?.myPoints).toBe(12)
})

it('does not keep polling after the route unmounts', async () => {
    await h.render(); connected(); await h.unmount()
    await advance(60_000)
    expect(boundary.checks).not.toHaveBeenCalled()
})

it('retries version failures without clearing an otherwise usable cached view', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.render(); connected()
    boundary.checks.mockImplementationOnce(() => { throw new Error('temporary outage') })
    await advance(20_000)
    expect(h.latest.matchup?.myPoints).toBe(200)
    expect(boundary.read).toHaveBeenCalledOnce()
    changedServer()
    await advance(20_250)
    expect(h.latest.matchup?.myPoints).toBe(12)
    log.mockRestore()
})

it('stops the live guard as soon as a fresh view confirms all games are final', async () => {
    await h.render(); connected(); changedServer()
    boundary.read.mockResolvedValue(payload(12, games('Final')))
    await advance(20_250)
    const checks = boundary.checks.mock.calls.length
    await advance(120_000)
    expect(boundary.checks).toHaveBeenCalledTimes(checks)
})

it('watches current games while another day is selected and stops once the current slate ends', async () => {
    const today = '2026-10-29'
    const dated = (date: string, points: number) => ({ ...payload(points, date === today ? games() : []), selectedDate: date,
        weekDays: [{ date: today, dayLabel: 'Today', dateNum: 29, hasGames: true, isToday: true, playingTeams: ['BOS'] }] })
    boundary.read.mockImplementation(async scope => dated(String(scope.params.date), 200))
    boundary.games.mockResolvedValueOnce({ data: games(), error: null }).mockResolvedValue({ data: games('Final'), error: null })
    await h.render(); connected()
    await act(async () => { h.latest.setSelectedDate('2026-10-28') })
    await advance(0)
    expect(boundary.games).toHaveBeenCalledOnce()
    changedServer()
    boundary.read.mockImplementation(async scope => dated(String(scope.params.date), 12))
    await advance(20_250)
    expect(h.latest.matchup?.myPoints).toBe(12)
    expect(h.latest.selectedDate).toBe('2026-10-28')
    expect(boundary.games).toHaveBeenCalledTimes(2)
    const checks = boundary.checks.mock.calls.length
    await advance(60_000)
    expect(boundary.checks).toHaveBeenCalledTimes(checks)
})

it('marks inactive Home aliases dirty on a raw score hint without disturbing Players', async () => {
    await h.render(); connected()
    const other = { accountId: 'account', leagueId: 'league', screen: 'home' as const, params: { date: '2026-10-28' } }
    const players = { accountId: 'account', leagueId: 'league', screen: 'players' as const }
    saveScreenView(other, payload(), '1'); saveScreenView(players, { players: [] }, '1')
    await act(async () => { notifyLeagueChange('league', { topic: 'score', scopes: null }) })
    expect(cachedScreenView(other)?.dirty).toBe(true)
    expect(cachedScreenView(players)?.dirty).toBe(false)
})

it('validates a saved quiet matchup when an inactive route becomes focused', async () => {
    boundary.read.mockResolvedValue(payload(200, games('Final')))
    await h.render(); connected()
    boundary.focused = false; await h.render()
    changedServer()
    boundary.focused = true; await h.render()
    await advance(250)
    expect(h.latest.matchup?.myPoints).toBe(12)
})
