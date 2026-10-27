export function sourceBirthdate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const day = value.match(/^\d{4}-\d{2}-\d{2}(?=T|$)/)?.[0]
  if (!day || day < '1900-01-01' || day > new Date().toISOString().slice(0, 10)) return null
  const date = new Date(`${day}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null
}

export function sourceYearsExperience(
  athlete: { experience?: { years?: number }; debutYear?: number; draft?: { year?: number } },
  seasonYear: number,
): number | null {
  const years = athlete.experience?.years
  if (typeof years === 'number' && Number.isInteger(years) && years >= 0) return Math.max(0, years - 1)
  const firstYear = athlete.debutYear ?? athlete.draft?.year
  return typeof firstYear === 'number' && Number.isInteger(firstYear) && firstYear > 1946 && firstYear <= seasonYear
    ? Math.max(0, seasonYear - 1 - firstYear) : null
}
