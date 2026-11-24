const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g

export const AMBIGUOUS = '__ambiguous__'

export function setUnique(map: Map<string, string>, key: string, value: string): void {
  const existing = map.get(key)
  if (!existing) map.set(key, value)
  else if (existing !== value) map.set(key, AMBIGUOUS)
}

export function normalizeName(name: string): string {
  const key = name
    .normalize('NFD').replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(SUFFIX_RE, '')
    .replace(/[.'\u2019\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (key === 'valdez edgecombe') return 'vj edgecombe'
  if (key === 'airious bailey') return 'ace bailey'
  return key
}
