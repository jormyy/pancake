const DAY_MS = 86_400_000

/** @param {number} seasonYear @param {number} throughWeek */
export const seasonWeekRows = (seasonYear, throughWeek = 26) => {
  if (!Number.isInteger(seasonYear) || seasonYear < 1900 || seasonYear > 9999 ||
      !Number.isInteger(throughWeek) || throughWeek < 1) {
    throw new Error('Fixture calendar requires a four-digit season year and positive whole weeks')
  }
  const opening = Date.UTC(seasonYear - 1, 9, 20)
  const monday = opening - ((new Date(opening).getUTCDay() + 6) % 7) * DAY_MS
  return Array.from({ length: throughWeek }, (_, index) => ({
    season_year: seasonYear,
    week_number: index + 1,
    week_start: new Date(monday + index * 7 * DAY_MS).toISOString().slice(0, 10),
    week_end: new Date(monday + (index * 7 + 6) * DAY_MS).toISOString().slice(0, 10),
  }))
}

/** @param {string} date */
export const seasonYearForDate = (date) => Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) >= 10 ? 1 : 0)

/** @param {{ playoff_start_week?: number | null, playoff_total_weeks?: number | null, playoff_round_weeks?: number[] | null }} league */
export const calendarWeeksForLeague = (league) => Math.max(26,
  (league.playoff_start_week ?? 20) + (league.playoff_round_weeks?.reduce((sum, weeks) => sum + weeks, 0)
    ?? league.playoff_total_weeks ?? 3) - 1)
