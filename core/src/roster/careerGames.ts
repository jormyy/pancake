type CareerPayload = {
    filters?: { name?: string; value?: string }[]
    categories?: {
        names?: string[]
        labels?: string[]
        totals?: unknown[]
        statistics?: { season?: { year?: number }; stats?: unknown[]; teamId?: string; displayName?: string }[]
    }[]
}

function nbaCareer(payload: unknown): CareerPayload | null {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as CareerPayload
    if (!Array.isArray(source.filters) || !source.filters.some(filter => filter?.name === 'league' && filter.value === 'nba')) return null
    if (source.categories !== undefined && !Array.isArray(source.categories)) return null
    return source
}

function gamesIndex(category: NonNullable<CareerPayload['categories']>[number]): number {
    const index = Array.isArray(category.names) ? category.names.indexOf('gamesPlayed') : -1
    return index >= 0 ? index : Array.isArray(category.labels) ? category.labels.indexOf('GP') : -1
}

function gamesNumber(raw: unknown): number | null {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw))) return null
    const games = Number(raw)
    return Number.isSafeInteger(games) ? games : null
}

export function careerRegularSeasonGames(payload: unknown, yearsExp: number | null = null): number | null {
    const source = nbaCareer(payload)
    if (!source) return null
    const season = source.filters!.find(filter => filter?.name === 'seasontype')
    if (!season && source.filters!.length === 1 && !source.categories?.length && yearsExp === 0) return 0
    if (season?.value !== '2') return null
    for (const category of source.categories ?? []) {
        if (!category) continue
        const index = gamesIndex(category)
        if (index < 0) continue
        return Array.isArray(category.totals) ? gamesNumber(category.totals[index]) : null
    }
    return null
}

export function careerFirstSeasonYear(payload: unknown): number | null {
    const source = nbaCareer(payload)
    if (!source?.filters?.some(filter => filter?.name === 'seasontype' && filter.value === '2')) return null
    const years: number[] = []
    for (const category of source.categories ?? []) {
        if (!category || !Array.isArray(category.statistics)) continue
        const index = gamesIndex(category)
        if (index < 0) continue
        for (const row of category.statistics) {
            const year = row?.season?.year
            const games = Array.isArray(row?.stats) ? gamesNumber(row.stats[index]) : null
            if (typeof year === 'number' && Number.isInteger(year) && year > 1946 && games !== null && games > 0) years.push(year)
        }
    }
    return years.length > 0 ? Math.min(...years) : null
}


export function careerGamesBase(payload: unknown, completedSeason: number): number | null {
    const source = nbaCareer(payload)
    if (!source?.filters?.some(filter => filter?.name === 'seasontype' && filter.value === '2')
        || !Number.isInteger(completedSeason) || completedSeason < 1946) return null
    for (const category of source.categories ?? []) {
        if (!category) continue
        const index = gamesIndex(category)
        if (index < 0 || !Array.isArray(category.statistics) || category.statistics.length === 0) continue
        const seasons = new Map<number, { parts: number; total: number | null }>()
        for (const row of category.statistics) {
            const year = row?.season?.year
            if (typeof year !== 'number' || !Number.isInteger(year) || year <= 1946) return null
            const games = Array.isArray(row.stats) ? gamesNumber(row.stats[index]) : null
            if (games === null) {
                if (year > completedSeason) continue
                return null
            }
            const season = seasons.get(year) ?? { parts: 0, total: null }
            if (/\bTotals?$/i.test(row.displayName ?? '')) {
                if (season.total !== null && season.total !== games) return null
                season.total = games
            } else {
                season.parts += games
            }
            seasons.set(year, season)
        }
        let base = 0
        let total = 0
        for (const [year, season] of seasons) {
            if (season.total !== null && season.parts > 0 && season.total !== season.parts) return null
            const games = season.total ?? season.parts
            total += games
            if (year <= completedSeason) base += games
        }
        const reported = careerRegularSeasonGames(payload)
        if (reported !== null && Math.abs(reported - total) > 1) return null
        return Number.isSafeInteger(base) && base <= 2147483647 ? base : null
    }
    return null
}
