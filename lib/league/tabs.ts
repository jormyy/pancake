export type LeagueSection = 'results' | 'history' | 'picks' | 'draft' | 'settings'
export type LeagueTab = LeagueSection | 'draftBoard' | 'auctions' | 'mockRooms'

export const LEAGUE_TABS: readonly { key: LeagueSection; label: string }[] = [
    { key: 'results', label: 'Standings' },
    { key: 'history', label: 'Activity' },
    { key: 'picks', label: 'Picks' },
    { key: 'draft', label: 'Draft' },
    { key: 'settings', label: 'Settings' },
]

const LEAGUE_TAB_ALIASES: Record<string, LeagueSection> = {
    results: 'results',
    standings: 'results',
    history: 'history',
    activity: 'history',
    picks: 'picks',
    draftBoard: 'picks',
    'draft-board': 'picks',
    draft: 'draft',
    auctions: 'draft',
    mockRooms: 'draft',
    'mock-rooms': 'draft',
    settings: 'settings',
}

export function parseLeagueTab(tab: unknown): LeagueSection {
    return typeof tab === 'string' && Object.hasOwn(LEAGUE_TAB_ALIASES, tab)
        ? LEAGUE_TAB_ALIASES[tab]
        : 'results'
}
