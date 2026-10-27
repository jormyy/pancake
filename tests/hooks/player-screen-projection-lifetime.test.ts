import { boundary, held } from '../helpers/screen-view-boundary'
import { playerHarness, playerPayload } from '../helpers/player-view-fixture'
import { act } from 'react-test-renderer'
import { expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = playerHarness()
it('reads the current projection after suspension before the old view settles', async () => {
    const old = held<ReturnType<typeof playerPayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(playerPayload('player', 1, 42))
    await h.render(); boundary.focused = false; await h.render(); boundary.focused = true; await h.render()
    expect(h.latest.nextProjection?.projection_fantasy_points).toBe(42)
    await act(async () => old.resolve(playerPayload('player', 1, 5)))
    expect(h.latest.nextProjection?.projection_fantasy_points).toBe(42)
})
