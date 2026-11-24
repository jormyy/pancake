import { StyleSheet, Text, View } from 'react-native'
import { colors, fontWeight, palette, radii, spacing, typeScale } from '@/constants/tokens'

/** Out, injured reserve, and day-to-day show as a tag on the headshot rather than a badge beside the name. */
export function injuryTagKind(status: string | null | undefined): 'out' | 'ir' | 'dtd' | null {
    const value = status?.trim().toLowerCase()
    if (value === 'out') return 'out'
    if (value === 'ir') return 'ir'
    if (value === 'day-to-day' || value === 'gtd' || value === 'dtd') return 'dtd'
    return null
}

const TAGS = {
    out: { text: 'OUT', label: 'Out', color: palette.red600 },
    ir: { text: 'IR', label: 'Injured reserve', color: palette.red600 },
    dtd: { text: 'DTD', label: 'Day-To-Day', color: palette.amber600 },
} as const

/** "OUT", "IR", or "DTD" centred on the headshot's bottom edge; nothing when healthy or another status. */
export function InjuryTag({ status, avatarSize }: { status: string | null | undefined; avatarSize: number }) {
    const kind = injuryTagKind(status)
    if (!kind) return null
    const tag = TAGS[kind]
    return (
        <View style={styles.anchor} pointerEvents="none">
            <Text testID="injury-tag" accessibilityLabel={tag.label}
                style={[styles.tag, avatarSize >= LARGE_AVATAR && styles.tagLarge, { backgroundColor: tag.color }]}>
                {tag.text}
            </Text>
        </View>
    )
}

// Fixed (not themed) fills keep white text readable in light and dark mode.
// Bigger headshots (player page) get a slightly larger tag.
const LARGE_AVATAR = 48

const styles = StyleSheet.create({
    anchor: { position: 'absolute', left: spacing.none, right: spacing.none, bottom: -spacing.xs, alignItems: 'center' },
    tag: { ...typeScale.micro, fontWeight: fontWeight.extrabold, color: colors.textWhite, paddingHorizontal: spacing.xxs, borderRadius: radii.sm, overflow: 'hidden' },
    tagLarge: { ...typeScale.caption, paddingHorizontal: spacing.xs },
})
