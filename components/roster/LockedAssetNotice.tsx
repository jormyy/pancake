import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ElementType, ReactNode } from 'react'
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import { colors, componentTokens, controlSize, spacing } from '@/constants/tokens'
import { assetLockReason, type AssetLock } from '@/lib/locked-assets'

async function explainLock(reason: string) {
    const { showAlert } = await import('@/lib/alert')
    showAlert('', reason, 'info')
}

export function LockedAssetNotice({ locks }: { locks: readonly AssetLock[] }) {
    const reason = assetLockReason(locks)
    if (!reason) return null
    return <Pressable style={styles.icon} hitSlop={spacing.xs}
        accessibilityRole="button" accessibilityLabel={reason} accessibilityState={{ disabled: false }}
        onPress={event => { event.stopPropagation(); return explainLock(reason) }}
        onLongPress={event => { event.stopPropagation(); return explainLock(reason) }}>
        <MaterialIcons name="lock" size={controlSize.icon.sm} color={colors.textMuted} accessible={false} />
    </Pressable>
}

export function AssetSelectionRow({ locks, children, style, component: Row = Pressable, disabledOpacity, label, ...props }: Omit<PressableProps, 'style' | 'children' | 'accessibilityLabel'> & {
    locks: readonly AssetLock[]; label: string; children: ReactNode; style?: StyleProp<ViewStyle>; component?: ElementType; disabledOpacity?: number
}) {
    if (!props.disabled || !locks.length) return <Row {...props} accessibilityLabel={label} style={style}
        {...(Row === Pressable ? {} : { disabledOpacity })}>{children}</Row>
    return <View style={[style, Row !== Pressable && { opacity: disabledOpacity ?? 0.58 }]}>
        <Pressable {...props} accessibilityLabel={label} style={StyleSheet.absoluteFillObject} />
        {children}
    </View>
}

export function LockedActionExplanation({ locks, label, children, busy = false }: {
    locks: readonly AssetLock[]; label: string; children: ReactNode; busy?: boolean
}) {
    const reason = assetLockReason(locks)
    return <View>
        {children}
        {reason && !busy ? <Pressable style={StyleSheet.absoluteFillObject}
            accessibilityRole="button" accessibilityLabel={`Explain unavailable ${label}`} accessibilityHint={reason}
            onPress={() => explainLock(reason)}
            onLongPress={() => explainLock(reason)} /> : null}
    </View>
}

const styles = StyleSheet.create({
    icon: { minWidth: controlSize.icon.sm, minHeight: componentTokens.badge.inline.minHeight, alignItems: 'center', justifyContent: 'center' },
})
