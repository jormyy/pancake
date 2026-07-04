import { describe, expect, it } from 'vitest'
import { nextDialogFocusIndex } from '../components/ui/dialogFocus'
import { nextRovingIndex } from '../components/ui/rovingFocus'

describe('shared UI accessibility behavior', () => {
    it('wraps roving keyboard focus across horizontal controls', () => {
        expect(nextRovingIndex(0, 'ArrowRight', 3)).toBe(1)
        expect(nextRovingIndex(2, 'ArrowRight', 3)).toBe(0)
        expect(nextRovingIndex(0, 'ArrowLeft', 3)).toBe(2)
        expect(nextRovingIndex(1, 'Home', 3)).toBe(0)
        expect(nextRovingIndex(1, 'End', 3)).toBe(2)
        expect(nextRovingIndex(1, 'Enter', 3)).toBeNull()
        expect(nextRovingIndex(0, 'ArrowRight', 0)).toBeNull()
    })

    it('wraps dialog tab focus in both directions', () => {
        expect(nextDialogFocusIndex(-1, 3)).toBe(0)
        expect(nextDialogFocusIndex(0, 3)).toBe(1)
        expect(nextDialogFocusIndex(2, 3)).toBe(0)
        expect(nextDialogFocusIndex(-1, 3, true)).toBe(2)
        expect(nextDialogFocusIndex(0, 3, true)).toBe(2)
        expect(nextDialogFocusIndex(2, 3, true)).toBe(1)
        expect(nextDialogFocusIndex(0, 0)).toBeNull()
    })
})
