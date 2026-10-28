import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, controlSize, fontFamily, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

type Props = {
    seasons: number[]
    selectedSeason: number
    onSelect: (season: number) => void
}

export function SeasonSelector({ seasons, selectedSeason, onSelect }: Props) {
    if (seasons.length <= 1) return null

    return (
        <div style={{ position: 'relative', display: 'inline-flex', minWidth: 104 }}>
            <select
                aria-label="Season"
                value={selectedSeason}
                onChange={event => onSelect(Number(event.currentTarget.value))}
                style={{
                    minHeight: 44,
                    height: 44,
                    width: '100%',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    padding: spacing.sm,
                    paddingRight: spacing['3xl'],
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: radii.md,
                    backgroundColor: colors.bgCard,
                    color: colors.textPrimary,
                    fontFamily: fontFamily.control,
                    fontSize: fontSize.lg,
                    fontWeight: fontWeight.semibold,
                    cursor: 'pointer',
                }}
            >
                {seasons.map(year => (
                    <option key={year} value={year}>{year - 1}–{String(year).slice(2)}</option>
                ))}
            </select>
            <span
                aria-hidden="true"
                style={{ position: 'absolute', right: spacing.md, top: spacing.none, bottom: spacing.none, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}
            >
                <MaterialIcons name="expand-more" size={controlSize.icon.md} color={colors.textMuted} />
            </span>
        </div>
    )
}
