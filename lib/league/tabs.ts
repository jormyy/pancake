export type LeagueSection = 'results' | 'seasons' | 'history' | 'picks' | 'schedule' | 'draft' | 'bracket' | 'settings'
export type LeagueTab = LeagueSection | 'draftBoard' | 'auctions' | 'mockRooms'

export const LEAGUE_TABS: readonly { key: LeagueSection; label: string }[] = [
    { key: 'results', label: 'Standings' },
    { key: 'history', label: 'Activity' },
    { key: 'picks', label: 'Picks' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'seasons', label: 'History' },
    { key: 'draft', label: 'Draft' },
    { key: 'bracket', label: 'Playoffs' },
    { key: 'settings', label: 'Settings' },
]

const LEAGUE_TAB_ALIASES: Record<string, LeagueSection> = {
    results: 'results',
    standings: 'results',
    seasons: 'seasons',
    history: 'history',
    activity: 'history',
    picks: 'picks',
    schedule: 'schedule',
    draftBoard: 'picks',
    'draft-board': 'picks',
    draft: 'draft',
    auctions: 'draft',
    mockRooms: 'draft',
    'mock-rooms': 'draft',
    settings: 'settings',
    bracket: 'bracket',
    playoffs: 'bracket',
}

export function parseLeagueTab(tab: unknown): LeagueSection {
    return typeof tab === 'string' && Object.hasOwn(LEAGUE_TAB_ALIASES, tab)
        ? LEAGUE_TAB_ALIASES[tab]
        : 'results'
}
