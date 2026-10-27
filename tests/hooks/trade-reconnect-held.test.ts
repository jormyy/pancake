import { boundary, held } from '../helpers/screen-view-boundary'
import { tradeHarness, tradePayload } from '../helpers/trade-view-fixture'
import { act } from 'react-test-renderer'
import { expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = tradeHarness()
it('admits fresh recovery before an old held response settles and rejects its completion', async () => {
    const old = held<ReturnType<typeof tradePayload>>()
    boundary.read.mockReturnValueOnce(old.promise).mockResolvedValue(tradePayload(['fresh']))
    await h.render(); boundary.online = false; await h.render({ online: false })
    expect(h.offers.loading).toBe(false)
    expect(h.offers.isSnapshot).toBe(true)
    boundary.online = true; await h.render()
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['fresh'])
    expect(h.offers.isSnapshot).toBe(false)
    await act(async () => old.resolve(tradePayload(['old'])))
    expect(h.offers.trades.map(trade => trade.id)).toEqual(['fresh'])
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
