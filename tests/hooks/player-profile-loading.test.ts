import { boundary, bumpView, held } from '../helpers/screen-view-boundary'
import { playerHarness, playerPayload } from '../helpers/player-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'
import { loadPickupState } from '@/lib/roster-add-flow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = playerHarness()
const overview = () => ({ ...playerPayload(), lines: undefined, averages: { gamesPlayed: 80, avgPoints: 24 }, player: { ...playerPayload().player, injury_status: 'Out' }, pickup: { status: { status: 'free_agent' }, transactionState: null, claimPending: false, roster: [] } })
beforeEach(() => { boundary.read.mockImplementation(async scope => {
    if (scope.params.section === 'games') return { context: { version: '1' }, lines: playerPayload('player', 16).lines, hasMoreGames: true }
    if (scope.params.section === 'news') return { context: { version: '1' }, news: [{ id: 'news', title: 'Update' }] }
    if (scope.params.section === 'history') return { context: { version: '1' }, transactions: [{ id: 'transaction' }] }
    return overview()
}) })

it('loads only the overview and shares its pickup data with the profile actions', async () => {
    await h.render()
    await expect(loadPickupState('player', 'member', 'league')).resolves.toMatchObject({ status: { status: 'free_agent' } })
    expect(boundary.read).toHaveBeenCalledTimes(1)
    expect(boundary.read.mock.calls[0][0].params.section).toBe('overview')
    expect(h.latest.player).toMatchObject({ injury_status: 'Out' })
    expect(h.latest.seasonAverages?.avgPoints).toBe(24)
    expect(h.latest.nextProjection).not.toBeNull()
    expect(h.latest.gameLog).toEqual([])
    expect(h.latest.transactions).toEqual([])
    expect(h.latest.news).toEqual([])
    expect(h.frames.filter(frame => frame.player).every(frame => frame.seasonAverages?.avgPoints === 24 && frame.nextProjection !== null)).toBe(true)
})

it('loads each section only when opened and reuses it on reopen', async () => {
    await h.render()
    for (const section of ['games', 'news', 'history'] as const) {
        await act(async () => h.latest.toggleSection(section))
        expect(boundary.read.mock.calls.at(-1)?.[0].params.section).toBe(section)
    }
    expect(boundary.read).toHaveBeenCalledTimes(4)
    expect(h.latest.gameLog).toHaveLength(15)
    expect(h.latest.hasMoreGames).toBe(true)
    expect(h.latest.news).toHaveLength(1)
    expect(h.latest.transactions).toHaveLength(1)
    await act(async () => h.latest.toggleSection('games'))
    await act(async () => h.latest.toggleSection('games'))
    expect(boundary.read).toHaveBeenCalledTimes(4)
})

it('keeps cached above-fold data on reopen while refreshing in the background', async () => {
    await h.render()
    await h.render({ authorized: false })
    const refresh = held<ReturnType<typeof overview>>()
    boundary.read.mockReturnValue(refresh.promise)
    bumpView()
    h.frames.length = 0
    await h.render()
    expect(h.frames[0].player?.id).toBe('player')
    expect(h.frames[0].seasonAverages?.avgPoints).toBe(24)
    await act(async () => refresh.resolve({ ...overview(), averages: { gamesPlayed: 81, avgPoints: 25 } }))
    expect(h.latest.seasonAverages?.avgPoints).toBe(25)
})

it('keeps visible games while the next requested page loads', async () => {
    await h.render()
    await act(async () => h.latest.toggleSection('games'))
    const pending = held<{ context: { version: string }; lines: ReturnType<typeof playerPayload>['lines']; hasMoreGames: boolean }>()
    boundary.read.mockReturnValue(pending.promise)
    await act(async () => { void h.latest.loadMoreGames() })
    expect(h.latest.gameLog).toHaveLength(15)
    expect(h.latest.gameLogLoading).toBe(true)
    expect(boundary.read.mock.calls.at(-1)?.[0].params.gameLimit).toBe(30)
    await act(async () => pending.resolve({ context: { version: '1' }, lines: playerPayload('player', 31).lines, hasMoreGames: true }))
    expect(h.latest.gameLog).toHaveLength(30)
})
