import { ReactNode } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, elevation, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'

type Props = {
    visible: boolean
    onClose: () => void
    title?: string
    children: ReactNode
    /** Centered dialog instead of a bottom-anchored sheet. */
    center?: boolean
    maxHeight?: number
}

/** One scrim + sheet primitive for all bottom sheets / centered dialogs. */
export function BottomSheet({ visible, onClose, title, children, center = false, maxHeight }: Props) {
    const insets = useSafeAreaInsets()

    return (
        <Modal visible={visible} transparent animationType={Platform.OS === 'web' ? 'fade' : 'none'} onRequestClose={onClose}>
            <Pressable style={[styles.scrim, center && styles.scrimCenter]} onPress={onClose} accessibilityLabel="Close">
                <Animated.View
                    entering={center ? undefined : SlideInDown.duration(260)}
                    exiting={center ? undefined : SlideOutDown.duration(200)}
                    style={[
                        center ? styles.dialog : styles.sheet,
                        !center && { paddingBottom: insets.bottom + spacing.xl },
                        maxHeight ? { maxHeight } : null,
                    ]}
                >
                    <Pressable onPress={() => {}} style={styles.inner}>
                        {title ? (
                            <View style={styles.header}>
                                <Text style={styles.title}>{title}</Text>
                                <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
                                    <MaterialIcons name="close" size={20} color={colors.textPrimary} />
                                </Pressable>
                            </View>
                        ) : null}
                        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                            {children}
                        </ScrollView>
                    </Pressable>
                </Animated.View>
            </Pressable>
        </Modal>
    )
}

const styles = StyleSheet.create({
    scrim: {
        flex: 1,
        backgroundColor: scrim,
        justifyContent: 'flex-end',
    },
    scrimCenter: {
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.xl,
    },
    sheet: {
        backgroundColor: colors.bgCard,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous',
        paddingTop: spacing.sm,
        ...(elevation('xl') as object),
    },
    dialog: {
        width: '100%',
        maxWidth: 460,
        backgroundColor: colors.bgCard,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        ...(elevation('xl') as object),
    },
    inner: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    title: { flex: 1, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    closeBtn: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
    },
    content: { paddingBottom: spacing.lg },
})
