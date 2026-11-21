import { StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, lineHeight, palette, radii, spacing, tracking } from '@/constants/tokens'

/** Out and day-to-day show as a tag on the headshot rather than a badge beside the name. */
export function injuryTagKind(status: string | null | undefined): 'out' | 'dtd' | null {
    const value = status?.trim().toLowerCase()
    if (value === 'out') return 'out'
    if (value === 'day-to-day' || value === 'gtd' || value === 'dtd') return 'dtd'
    return null
}

/** "OUT" or "DTD" centred on the headshot's bottom edge; nothing when healthy or another status. */
export function InjuryTag({ status, avatarSize }: { status: string | null | undefined; avatarSize: number }) {
    const kind = injuryTagKind(status)
    if (!kind) return null
    return (
        <View style={styles.anchor} pointerEvents="none">
            <Text testID="injury-tag" accessibilityLabel={kind === 'out' ? 'Out' : 'Day-To-Day'}
                style={[styles.tag, avatarSize >= LARGE_AVATAR && styles.tagLarge, { backgroundColor: kind === 'out' ? palette.red600 : palette.amber600 }]}>
                {kind === 'out' ? 'OUT' : 'DTD'}
            </Text>
        </View>
    )
}

// Fixed (not themed) fills keep white text readable in light and dark mode.
// Bigger headshots (player page) get a slightly larger tag.
const LARGE_AVATAR = 48

const styles = StyleSheet.create({
    anchor: { position: 'absolute', left: spacing.none, right: spacing.none, bottom: -spacing.xs, alignItems: 'center' },
    tag: { fontSize: fontSize['2xs'], lineHeight: fontSize['2xs'] + spacing.xxs, fontWeight: fontWeight.extrabold, color: colors.textWhite, paddingHorizontal: spacing.xxs, borderRadius: radii.sm, overflow: 'hidden', letterSpacing: tracking.tight },
    tagLarge: { fontSize: fontSize.xs, lineHeight: lineHeight.meta, paddingHorizontal: spacing.xs },
})
