import { describe, expect, it } from 'vitest'
import { createAuthStorage } from '@/lib/auth-storage'

function fixture() {
    const values = new Map<string, string>([['session', 'old-identity']])
    const failures = new Set<string>()
    const adapter = createAuthStorage(() => {
        if (failures.has('access')) throw new Error('denied accessor')
        return {
            getItem(key: string) { if (failures.has('get')) throw new Error('denied read'); return values.get(key) ?? null },
            setItem(key: string, value: string) { if (failures.has('set')) throw new Error('quota'); values.set(key, value) },
            removeItem(key: string) { if (failures.has('remove')) throw new Error('denied removal'); values.delete(key) },
        }
    })
    return { values, failures, adapter }
}

describe('auth storage operations', () => {
    it.each(['access', 'get'])('returns unavailable, not a cached identity, after %s denial', (failure) => {
        const f = fixture()
        expect(f.adapter.getItem('session')).toBe('old-identity')
        f.failures.add(failure)
        expect(f.adapter.read('session')).toEqual({ value: null, available: false })
        expect(f.adapter.getItem('session')).toBeNull()
    })
    it('does not replay the old stored account after a failed new-account save', () => {
        const f = fixture()
        f.failures.add('set')
        expect(() => f.adapter.setItem('session', 'new-identity')).not.toThrow()
        expect(f.adapter.read('session')).toEqual({ value: null, available: false })
        expect(f.values.has('session')).toBe(false)
        f.failures.clear()
        f.adapter.setItem('session', 'new-identity')
        expect(f.adapter.getItem('session')).toBe('new-identity')
    })
    it('writes a tombstone when deletion fails and never replays the old account', () => {
        const f = fixture()
        f.failures.add('remove')
        expect(() => f.adapter.removeItem('session')).not.toThrow()
        expect(f.adapter.getItem('session')).toBeNull()
        expect(f.values.get('session')).toBe('')
    })
    it('fails closed for the document when all storage mutations fail', () => {
        const f = fixture()
        f.failures.add('remove'); f.failures.add('set')
        expect(() => f.adapter.removeItem('session')).not.toThrow()
        expect(f.adapter.read('session')).toEqual({ value: null, available: false })
        expect(f.values.get('session')).toBe('old-identity')
    })
    it('does not restore a saved identity from a read-only store after a restart', () => {
        const values = new Map([['session', 'old-identity']])
        const adapter = createAuthStorage(() => ({
            getItem: (key) => values.get(key) ?? null,
            setItem: () => { throw new Error('read-only') },
            removeItem: () => { throw new Error('read-only') },
        }))
        expect(adapter.read('session')).toEqual({ value: null, available: false })
        expect(values.get('session')).toBe('old-identity')
    })
})
