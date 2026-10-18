export function careerRegularSeasonGames(payload: unknown): number | null {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as {
        filters?: { name?: string; value?: string }[]
        categories?: { names?: string[]; labels?: string[]; totals?: unknown[] }[]
    }
    if (!source.filters?.some((filter) => filter.name === 'seasontype' && filter.value === '2') ||
        !source.filters.some((filter) => filter.name === 'league' && filter.value === 'nba')) return null
    for (const category of source.categories ?? []) {
        const index = category.names?.indexOf('gamesPlayed') ?? -1
        const gpIndex = index >= 0 ? index : category.labels?.indexOf('GP') ?? -1
        if (gpIndex < 0) continue
        const raw = category.totals?.[gpIndex]
        if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw))) return null
        const games = Number(raw)
        return Number.isSafeInteger(games) ? games : null
    }
    return null
}
