import { ProjectionCard } from '@/components/projections/ProjectionCard'
import { spacing } from '@/constants/tokens'
import type { LeagueProjectionRow } from '@/lib/projections'

export function NextProjectionCard({ projection }: { projection: LeagueProjectionRow }) {
    const time = projection.next_game_time
        ? new Date(projection.next_game_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : null
    const nextGame = {
        ...projection,
        projection_date: projection.next_game_date ?? projection.projection_date,
        projection_status: time,
        projection_source_label: [projection.projection_source_label, projection.projection_is_fresh === false ? 'Outdated' : null].filter(Boolean).join(' · '),
        projection_view: '',
        projection_fetched_at: null,
        projection_minutes: null,
        projection_points: null,
        projection_rebounds: null,
        projection_assists: null,
        projection_steals: null,
        projection_blocks: null,
        projection_three_pointers_made: null,
        projection_turnovers: null,
    }

    return <ProjectionCard projection={nextGame} title="Next game projection" style={{ padding: spacing.md, gap: 0 }} />
}
