const KNOWN_SOURCES: Record<string, string> = {
    season_avg: 'Season averages',
    fantasypros_daily: 'FantasyPros',
    internal: 'Pancake',
    'Pancake deterministic pick curve': 'Pancake pick values',
    'local-demo': 'Demo data',
}

/** A data-source id as people read it: "fantasypros_daily" → "FantasyPros". */
export function readableSourceName(name: string): string {
    const known = KNOWN_SOURCES[name]
    if (known) return known
    if (!/[_-]/.test(name)) return name
    const words = name.split(/[_-]+/).filter(Boolean)
    return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ')
}
