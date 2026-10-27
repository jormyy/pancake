export type InjuryDetails = { injury_reason: string; injury_expected_return: string }

export function sourceInjuryDetails(value: unknown): InjuryDetails {
  const details = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const text = (key: string) => typeof details[key] === 'string' ? details[key].trim().slice(0, 200) : ''
  const location = [text('side'), text('type') || text('location')].filter(Boolean).join(' ')
  return {
    injury_reason: [location, text('detail')].filter(Boolean).join(': ') || 'unknown',
    injury_expected_return: text('returnDate') || 'unknown',
  }
}
