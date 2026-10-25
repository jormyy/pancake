export function isIREligible(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    const s = injuryStatus.toLowerCase()
    return s === 'out' || s.startsWith('ir')
}

export function isDTD(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    return injuryStatus.toLowerCase() === 'dtd'
}

export function isTaxiEligible(yearsExp: number | null, careerGames: number | null): boolean {
    return yearsExp === 0 || (careerGames != null && careerGames < 65)
}
