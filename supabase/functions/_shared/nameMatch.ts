const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i

// Sentinel for name-keyed lookup maps where one name maps to multiple players.
export const AMBIGUOUS = '__ambiguous__'

export function setUnique(map: Map<string, string>, key: string, value: string): void {
  const existing = map.get(key)
  if (!existing) map.set(key, value)
  else if (existing !== value) map.set(key, AMBIGUOUS)
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(SUFFIX_RE, '')
    .replace(/[.'\u2019\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
