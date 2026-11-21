import { INJURY_COLORS, colors } from '@/constants/tokens'
import { Badge } from '@/components/ui/Badge'
import { injuryTagKind } from '@/components/InjuryTag'

export { Badge } from '@/components/ui/Badge'

/** A player's injury status (IR, Questionable…) in its status color; nothing when healthy. Out and day-to-day are a headshot tag instead. */
export function InjuryBadge({ status }: { status: string | null | undefined }) {
    if (!status || injuryTagKind(status)) return null
    const value = status.trim().toLowerCase()
    const label = value === 'ir' ? 'IR' : status
    const accessibilityLabel = label === 'IR' ? 'Injured reserve' : status
    const colorKey = label
    return <Badge size="compact" label={label} accessibilityLabel={accessibilityLabel} color={INJURY_COLORS[colorKey] ?? colors.textMuted} variant="solid" />
}
