export function isIREligible(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    const s = injuryStatus.toLowerCase()
    return s === 'out' || s.startsWith('ir')
}

export function isDTD(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    return injuryStatus.toLowerCase() === 'dtd'
}

export function isTaxiEligible(nbaDraftNumber: number | null, yearsExp: number | null, careerGames: number | null = null, extended = false): boolean {
    return extended ? yearsExp === 0 || (careerGames != null && careerGames < 65) : nbaDraftNumber != null && yearsExp === 0
}
