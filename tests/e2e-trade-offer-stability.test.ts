import { expect, it } from 'vitest'
import { assertOfferStable } from './e2e/trade-offer-stability.mjs'

const settled = {
    at: 0,
    buttons: [{ disabled: null, background: 'orange', opacity: '1' }, { disabled: null, background: 'orange', opacity: '1' }],
    summary: ['Every kingdom needs its Castle: 21/20 · IR 1/2 · Taxi 3/3', 'Matthew: 20/20 · IR 2/2 · Taxi 3/3'],
}
it('accepts unchanged offers across background frames', () => {
    expect(() => assertOfferStable(settled, [settled, { ...settled, at: 1000 }])).not.toThrow()
})
it('rejects a flashing button even when the final frame recovers', () => {
    const flashing = { ...settled, buttons: settled.buttons.map(button => ({ ...button, opacity: '0.58' })) }
    expect(() => assertOfferStable(settled, [settled, flashing, settled])).toThrow('must stay stable')
})
it('rejects a disappearing summary even when the final frame recovers', () => {
    expect(() => assertOfferStable(settled, [settled, { ...settled, summary: [] }, settled])).toThrow('must stay stable')
})
