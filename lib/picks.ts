export function draftYear(seasonYear: number): number {
    return seasonYear
}

export function pickLabel(seasonYear: number, round: number): string {
    return `${draftYear(seasonYear)} Round ${round}`
}
