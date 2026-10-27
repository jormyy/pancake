import { boundary, held } from '../helpers/screen-view-boundary'
import { playerHarness, playerPayload } from '../helpers/player-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = playerHarness()
beforeEach(() => { boundary.read.mockImplementation(async scope => playerPayload(String(scope.params.playerId))) })
it('restores the same owner snapshot after a generation change while rejecting old reads', async () => {
    await h.render(); boundary.generation += 1; h.frames.length = 0; await h.render()
    expect(h.frames[0].player?.id).toBe('player')
    expect(boundary.read).toHaveBeenCalledOnce()
    const old = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockReturnValueOnce(old.promise)
    await act(async () => { h.latest.retrySeason() })
    boundary.generation += 1
    await h.render()
    await act(async () => old.resolve(playerPayload('old')))
    expect(h.latest.player?.id).toBe('player')
})
it('hides cached player state on the first render for a new player key', async () => {
    await h.render(); boundary.read.mockReturnValueOnce(new Promise(() => {})); h.frames.length = 0; await h.render({ player: 'other' })
    expect(h.frames.length).toBeGreaterThan(0)
    expect(h.frames.every(frame => frame.player === null && frame.nextProjection === null && frame.transactions.length === 0)).toBe(true)
})
