declare const seasonYearBrand: unique symbol
declare const draftYearBrand: unique symbol

export type SeasonYear = number & { readonly [seasonYearBrand]: true }
export type DraftYear = number & { readonly [draftYearBrand]: true }

export const leagueSeasonYear = (year: number) => year as SeasonYear
export const storedDraftYear = (year: number) => year as DraftYear
export const draftYearForSeason = (season: SeasonYear) => (season - 1) as DraftYear
export const lastFutureDraftYear = (season: SeasonYear, futurePickYears: number) => (season + futurePickYears - 1) as DraftYear

export function pickLabel(year: DraftYear, round: number): string {
    return `${year} Round ${round}`
}
