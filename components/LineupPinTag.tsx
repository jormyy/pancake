import { Badge } from '@/components/ui/Badge'
import { colors } from '@/constants/tokens'
import type { LineupPin } from '@/lib/lineup/pins'

export function LineupPinTag({ pin }: { pin?: LineupPin }) {
    return pin ? <Badge inline label={pin === 'start' ? 'Start' : 'Bench'} color={colors.primaryDark}
        accessibilityLabel={`Pinned to ${pin}`} /> : null
}
