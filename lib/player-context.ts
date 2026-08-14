import { formatPoints } from '@/lib/format'

export type PlayerContextInput = {
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

export function playerYearsExperienceLabel(yearsExp?: number | null): string | null {
    if (yearsExp == null) return null
    return yearsExp <= 0 ? 'Rookie' : `Yr ${yearsExp + 1}`
}

export function playerSeasonContextText(player: PlayerContextInput): string {
    return [
        player.avgFantasyPoints != null ? `${formatPoints(player.avgFantasyPoints)} FPts` : null,
        player.avgMinutesPlayed != null ? `${formatPoints(player.avgMinutesPlayed)} MIN` : null,
        playerYearsExperienceLabel(player.yearsExp),
    ].filter(Boolean).join(' · ') || 'No season stats'
}
