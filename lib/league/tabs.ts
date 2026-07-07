export type LeagueTab = 'results' | 'auctions' | 'mockRooms' | 'draftBoard' | 'settings' | 'history'

export const LEAGUE_TABS: readonly { key: LeagueTab; label: string }[] = [
    { key: 'results', label: 'Standings' },
    { key: 'auctions', label: 'Auctions' },
    { key: 'mockRooms', label: 'Mock Rooms' },
    { key: 'draftBoard', label: 'Draft Board' },
    { key: 'settings', label: 'Settings' },
    { key: 'history', label: 'History' },
]

const LEAGUE_TAB_KEYS = new Set<LeagueTab>(LEAGUE_TABS.map((tab) => tab.key))

export function parseLeagueTab(tab: unknown): LeagueTab {
    return typeof tab === 'string' && LEAGUE_TAB_KEYS.has(tab as LeagueTab) ? tab as LeagueTab : 'results'
}
