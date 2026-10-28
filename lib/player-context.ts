import { formatPoints } from '@/lib/format'

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
    return `${formatPoints(player.avgFantasyPoints ?? 0)} FP · ${formatPoints(player.avgMinutesPlayed ?? 0)} mins`
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
