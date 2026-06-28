import { vi } from 'vitest'

/** Creates a chainable supabase query-builder mock that resolves to `result`. */
export function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        range: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => q(data, error, count),
        update: () => q(data, error, count),
        delete: () => q(data, error, count),
        upsert: () => q(data, error, count),
        // Thenable so the chain itself can be awaited (e.g. select().eq().order())
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

/**
 * Creates a `supabase.from` mock that serves a queue of responses per table name.
 * Each call to `from(table)` pops the next response from that table's queue.
 * Once exhausted, falls back to { data: null, error: null }.
 */
export function makeFromMock(tableResponses: Record<string, Array<{ data?: any; error?: any; count?: number }>>) {
    const indexes: Record<string, number> = {}
    return vi.fn().mockImplementation((table: string) => {
        const responses = tableResponses[table] ?? []
        const idx = indexes[table] ?? 0
        indexes[table] = idx + 1
        const r = responses[idx] ?? { data: null, error: null }
        return q(r.data ?? null, r.error ?? null, r.count ?? null)
    })
}
