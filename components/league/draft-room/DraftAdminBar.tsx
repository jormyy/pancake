import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { MotionPressable } from '@/components/Motion'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export function DraftAdminBar({
    isPaused,
    showPause = true,
    showLabel = true,
    onPause,
    onResume,
    onReset,
    onStop,
    style,
}: {
    isPaused: boolean
    showPause?: boolean
    showLabel?: boolean
    onPause: () => void
    onResume: () => void
    onReset: () => void
    onStop: () => void
    style?: StyleProp<ViewStyle>
}) {
    return (
        <View style={[styles.adminBar, style]}>
            {showLabel ? <Text style={styles.adminBarLabel}>Commissioner</Text> : null}
            <View style={styles.adminBarBtns}>
                {showPause ? (
                    <MotionPressable
                        style={[styles.adminBtn, styles.adminBtnPause]}
                        onPress={isPaused ? onResume : onPause}
                        pressedScale={0.94}
                        accessibilityRole="button"
                        accessibilityLabel={isPaused ? 'Resume draft' : 'Pause draft'}
                    >
                        <Text style={styles.adminBtnPauseText}>{isPaused ? 'Resume' : 'Pause'}</Text>
                    </MotionPressable>
                ) : null}
                <MotionPressable
                    style={[styles.adminBtn, styles.adminBtnReset]}
                    onPress={onReset}
                    pressedScale={0.94}
                    accessibilityRole="button"
                    accessibilityLabel="Reset draft"
                >
                    <Text style={styles.adminBtnResetText}>Reset</Text>
                </MotionPressable>
                <MotionPressable
                    style={[styles.adminBtn, styles.adminBtnStop]}
                    onPress={onStop}
                    pressedScale={0.94}
                    accessibilityRole="button"
                    accessibilityLabel="Stop draft"
                >
                    <Text style={styles.adminBtnStopText}>Stop</Text>
                </MotionPressable>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    adminBar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.sm,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    adminBarLabel: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0,
        textTransform: 'uppercase' as const,
        color: colors.textMuted,
    },
    adminBarBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    adminBtn: {
        minHeight: 46,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderWidth: 1,
    },
    adminBtnReset: { backgroundColor: colors.bgCard, borderColor: colors.border },
    adminBtnPause: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    adminBtnStop: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
    adminBtnResetText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    adminBtnPauseText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    adminBtnStopText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dangerDark },
})
