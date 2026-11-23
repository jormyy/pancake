import { formatAvgPoints, formatStat } from '@/lib/format'

type PlayerContextInput = {
    position?: string | null
    eligiblePositions?: string[] | null
    yearsExp?: number | null
    avgFantasyPoints?: number | null
    avgMinutesPlayed?: number | null
}

export function playerEligiblePositions(player: PlayerContextInput): string[] {
    if (player.eligiblePositions?.length) return player.eligiblePositions
    return player.position ? [player.position] : []
}

export function playerSeasonContextText(player: PlayerContextInput): string {
    return `${formatAvgPoints(player.avgFantasyPoints ?? 0)} FP · ${formatStat(player.avgMinutesPlayed ?? 0)} mins`
}

export function playerAge(birthdate?: string | null, now = new Date()): number | null {
    if (!birthdate) return null
    const birth = new Date(`${birthdate.slice(0, 10)}T00:00:00Z`)
    if (!Number.isFinite(birth.getTime())) return null
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now).split('-').map(Number)
    const beforeBirthday = month - 1 < birth.getUTCMonth() ||
        (month - 1 === birth.getUTCMonth() && day < birth.getUTCDate())
    const age = year - birth.getUTCFullYear() - Number(beforeBirthday)
    return age >= 0 ? age : null
}

/** Age to one decimal, rounded down so it never reaches the next birthday early: 24.98 → 24.9. */
export function playerAgeDecimal(birthdate?: string | null, now = new Date()): number | null {
    const whole = playerAge(birthdate, now)
    if (whole == null || !birthdate) return null
    const birth = new Date(`${birthdate.slice(0, 10)}T00:00:00Z`)
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now).split('-').map(Number)
    const lastBirthday = Date.UTC(birth.getUTCFullYear() + whole, birth.getUTCMonth(), birth.getUTCDate())
    const nextBirthday = Date.UTC(birth.getUTCFullYear() + whole + 1, birth.getUTCMonth(), birth.getUTCDate())
    const fraction = (Date.UTC(year, month - 1, day) - lastBirthday) / (nextBirthday - lastBirthday)
    return Math.floor((whole + Math.min(Math.max(fraction, 0), 0.999)) * 10) / 10
}
