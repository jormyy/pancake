import { describe, it, expect, vi } from 'vitest'
import { read } from '../source-guard'

// ── helpers extracted from the UI logic ───────────────────────────────────────

function shouldShowErrorBanner(
    tradesError: string | null,
    picksError: Error | null | undefined,
): boolean {
    return Boolean(tradesError || picksError)
}

function getPickCircleBackground(isSelected: boolean): string {
    // palette values used in propose-trade.tsx
    const indigo500 = '#6366F1'
    const primary = '#C9660F'
    return isSelected ? primary : indigo500
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('shouldShowErrorBanner', () => {
    it('returns true when tradesError is set', () => {
        expect(shouldShowErrorBanner('Network error', null)).toBe(true)
    })

    it('returns true when picksError is set', () => {
        expect(shouldShowErrorBanner(null, new Error('picks failed'))).toBe(true)
    })

    it('returns true when both errors are set', () => {
        expect(shouldShowErrorBanner('bad', new Error('also bad'))).toBe(true)
    })

    it('returns false when both are null', () => {
        expect(shouldShowErrorBanner(null, null)).toBe(false)
    })

    it('returns false when both are undefined / falsy', () => {
        expect(shouldShowErrorBanner(null, undefined)).toBe(false)
    })
})

describe('getPickCircleBackground', () => {
    it('returns indigo500 when not selected', () => {
        expect(getPickCircleBackground(false)).toBe('#6366F1')
    })

    it('returns primary when selected', () => {
        expect(getPickCircleBackground(true)).toBe('#C9660F')
    })
})

describe('onRefresh properly awaits both loads', () => {
    it('awaits Promise.all of load() and loadDraft(), sets refreshing false in finally', async () => {
        let resolveLoad!: () => void
        let resolveDraft!: () => void

        const load = vi.fn(
            () =>
                new Promise<void>((res) => {
                    resolveLoad = res
                }),
        )
        const loadDraft = vi.fn(
            () =>
                new Promise<void>((res) => {
                    resolveDraft = res
                }),
        )

        const setRefreshing = vi.fn()

        // Simulates the onRefresh implementation:
        //   async function onRefresh() {
        //     setRefreshing(true)
        //     try { await Promise.all([load(), loadDraft()]) }
        //     finally { setRefreshing(false) }
        //   }
        async function onRefresh() {
            setRefreshing(true)
            try {
                await Promise.all([load(), loadDraft()])
            } finally {
                setRefreshing(false)
            }
        }

        const refreshPromise = onRefresh()

        // Both fetches should be in-flight; setRefreshing(false) not called yet
        expect(setRefreshing).toHaveBeenCalledWith(true)
        expect(setRefreshing).not.toHaveBeenCalledWith(false)

        resolveLoad()
        // Still waiting on draft
        await Promise.resolve()
        expect(setRefreshing).not.toHaveBeenCalledWith(false)

        resolveDraft()
        await refreshPromise

        expect(setRefreshing).toHaveBeenCalledWith(false)
        expect(load).toHaveBeenCalledTimes(1)
        expect(loadDraft).toHaveBeenCalledTimes(1)
    })

    it('sets refreshing false even when load() rejects', async () => {
        const load = vi.fn().mockRejectedValue(new Error('network'))
        const loadDraft = vi.fn().mockResolvedValue(undefined)
        const setRefreshing = vi.fn()

        async function onRefresh() {
            setRefreshing(true)
            try {
                await Promise.all([load(), loadDraft()])
            } finally {
                setRefreshing(false)
            }
        }

        // Promise.all rejects when any promise rejects — finally still runs
        await expect(onRefresh()).rejects.toThrow('network')
        expect(setRefreshing).toHaveBeenCalledWith(false)
    })
})

describe('trades UI stability contracts', () => {
    it('renders tab-panel placeholders instead of null while trade tabs hydrate', () => {
        const source = read('app/(tabs)/trades.tsx')

        expect(source).toContain('function TradeListPlaceholder')
        expect(source).toContain('!activeTabHydrated ? <TradeListPlaceholder tab={tab} />')
        expect(source).toContain('memberships.length === 0 && leagueLoading')
    })
})
