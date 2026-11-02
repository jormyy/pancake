type Scope = { season_id?: string; member_id?: string; date?: string | null; week?: number }
export type HomeSelection = { seasonId?: string | null; memberIds?: string[]; date?: string; week?: number }
type Hint = { topic: string; scopes?: Scope[] | null; details?: { resource: string }[] | null }
const topics = new Set(['roster', 'lineup', 'score', 'stat', 'player_stats', 'game', 'resources', 'inventory', 'announcement', 'forecast', 'settings', 'member', 'season'])

export function homeHintAffects(hint: Hint, selection: HomeSelection): boolean {
    if (['score', 'resources'].includes(hint.topic) && Array.isArray(hint.details) && hint.details.length
        && hint.details.every(detail => detail?.resource === 'averages')) return false
    if (hint.topic === 'inventory' && Array.isArray(hint.details) && hint.details.length
        && hint.details.every(detail => detail && ['picks', 'claims', 'waivers', 'priority', 'faab', 'activity'].includes(detail.resource))) return false
    if (!Array.isArray(hint.scopes) || !hint.scopes.length || !selection.seasonId
        || hint.scopes.some(scope => !scope || typeof scope !== 'object')) return true
    return hint.scopes.some(scope => (!scope.season_id || scope.season_id === selection.seasonId)
        && (scope.week == null || selection.week == null || scope.week === selection.week)
        && (hint.topic !== 'lineup' || !scope.date || !selection.date || scope.date === selection.date)
        && (hint.topic !== 'roster' || !scope.member_id || !selection.memberIds?.length || selection.memberIds.includes(scope.member_id)))
}

export function homeVersionAffects(change: { topic: string; scope: Record<string, unknown> }, selection: HomeSelection): boolean {
    if (change.topic === 'catchup') return true
    if (change.scope.homeChanged === false) return false
    const names = (Array.isArray(change.scope.topics) ? change.scope.topics : [change.topic])
        .map(topic => topic === 'members' ? 'member' : ['players', 'projections'].includes(String(topic)) ? 'resources' : topic === 'claims' ? 'claim' : topic)
    const hints = Array.isArray(change.scope.hints) ? change.scope.hints.filter((hint): hint is Hint => Boolean(hint && typeof hint === 'object' && typeof hint.topic === 'string')) : []
    const known = new Set([...topics, 'trade', 'claim', 'draft', 'activity', 'profile'])
    return names.some(topic => {
        if (typeof topic !== 'string' || !known.has(topic)) return true
        if (!topics.has(topic)) return false
        const scoped = hints.filter(hint => hint.topic === topic)
        return scoped.length === 0 || scoped.some(hint => homeHintAffects(hint, selection))
    })
}
