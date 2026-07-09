import { describe, expect, it } from 'vitest'
import { rollbackTradeDrop, selectTradeDrop } from '@/lib/trade-drop-selection'

describe('trade overflow drop selection', () => {
    it('restores the last candidate after a failed atomic accept without losing earlier choices', () => {
        const firstChoice = selectTradeDrop(new Set(), 'roster-a')
        const submitted = selectTradeDrop(firstChoice, 'roster-b')
        const retryable = rollbackTradeDrop(submitted, 'roster-b')
        expect([...retryable]).toEqual(['roster-a'])
        expect(submitted).toEqual(new Set(['roster-a', 'roster-b']))
    })
})
