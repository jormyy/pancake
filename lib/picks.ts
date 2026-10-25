export function draftYear(seasonYear: number): number {
    return seasonYear - 1
}

export function pickLabel(seasonYear: number, round: number): string {
    return `${draftYear(seasonYear)} Round ${round}`
}
