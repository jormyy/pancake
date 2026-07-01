import { ProjectionCard } from '@/components/projections/ProjectionCard'
import type { LeagueProjectionRow } from '@/lib/projections'

export function NextProjectionCard({ projection }: { projection: LeagueProjectionRow }) {
    return <ProjectionCard projection={projection} title="Next Projection" />
}
