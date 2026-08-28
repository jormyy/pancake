// A filter-aware fake of the Supabase client: every table read or RPC counts
// one request against its target and answers from in-memory fixtures.
type Row = Record<string, unknown>

export function createFakeSupabase(counts: Map<string, number>, fixtures: Record<string, Row[]>) {
    const applyFilters = (rows: Row[], filters: [string, unknown[]][]) => rows.filter((row) => filters.every(([op, args]) => {
        const [column, value] = args as [string, unknown]
        if (!(column in row)) return true
        if (op === 'eq') return row[column] === value
        if (op === 'neq') return row[column] !== value
        if (op === 'in') return (value as unknown[]).includes(row[column])
        if (op === 'is') return row[column] === value
        return true
    }))
    const builder = (target: string) => {
        counts.set(target, (counts.get(target) ?? 0) + 1)
        const filters: [string, unknown[]][] = []
        let single = false
        const proxy: Record<string, unknown> = new Proxy({}, {
            get(_, prop: string) {
                if (prop === 'then') {
                    return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
                        const rows = applyFilters(fixtures[target] ?? [], filters)
                        const data = single ? rows[0] ?? null : rows
                        return Promise.resolve({ data, error: null }).then(resolve, reject)
                    }
                }
                return (...args: unknown[]) => {
                    if (prop === 'maybeSingle' || prop === 'single') single = true
                    if (['eq', 'neq', 'in', 'is'].includes(prop)) filters.push([prop, args])
                    return proxy
                }
            },
        })
        return proxy
    }
    return {
        from: (table: string) => builder(table),
        rpc: (name: string) => builder(`rpc:${name}`),
    }
}
