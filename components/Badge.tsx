import { INJURY_COLORS, colors } from '@/constants/tokens'
import { Badge } from '@/components/ui/Badge'

export { Badge } from '@/components/ui/Badge'

/** A player's injury status (Out, GTD…) in its status color; nothing when healthy. */
export function InjuryBadge({ status }: { status: string | null | undefined }) {
    if (!status) return null
    const value = status.trim().toLowerCase()
    const label = value === 'out' ? 'O' : ['day-to-day', 'gtd', 'dtd'].includes(value) ? 'DTD' : value === 'ir' ? 'IR' : status
    const accessibilityLabel = label === 'O' ? 'Out' : label === 'DTD' ? 'Day-To-Day' : label === 'IR' ? 'Injured reserve' : status
    const colorKey = label === 'O' ? 'Out' : label === 'IR' ? 'IR' : label === 'DTD' ? 'DTD' : status
    return <Badge inline label={label} accessibilityLabel={accessibilityLabel} color={INJURY_COLORS[colorKey] ?? colors.textMuted} variant="solid" />
}
