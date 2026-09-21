import { describe, expect, it } from 'vitest'
import { blockedActionProps } from '@/lib/a11y'

describe('blockedActionProps', () => {
    it('announces the block as a hint on a still-pressable control', () => {
        expect(blockedActionProps('reason')).toEqual({ accessibilityHint: 'reason', accessibilityState: { disabled: true } })
        expect(blockedActionProps(null)).toEqual({ accessibilityHint: undefined, accessibilityState: { disabled: false } })
        expect(blockedActionProps(null, true)).toEqual({ accessibilityHint: undefined, accessibilityState: { disabled: true } })
    })
})
