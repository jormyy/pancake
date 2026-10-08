import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { ReactNode, useEffect, useId } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { breakpoints, colors, elevation, radii, scrim, spacing, textStyles } from '@/constants/tokens'
import { trapDialogTabFocus, type DialogKeyboardEvent } from './dialogFocus'
import { scheduleWebFocusRecovery } from './webFocus'

type WebKeyDownProps = { onKeyDown?: (event: DialogKeyboardEvent) => void }

/**
 * The one pop-up surface. On phones it rises from the bottom, within thumb
 * reach. On wider screens it is a centered window that leaves the page in view.
 */
export function Sheet({
    visible,
    title,
    onClose,
    children,
}: {
    visible: boolean
    title: string
    onClose: () => void
    children: ReactNode
}) {
    const { width } = useWindowDimensions()
    const insets = useSafeAreaInsets()
    const bottomSheet = width < breakpoints.compact
    const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const dialogId = `sheet-${id}`
    const titleId = `sheet-title-${id}`

    useEffect(() => {
        if (!visible || Platform.OS !== 'web' || typeof document === 'undefined') return
        return scheduleWebFocusRecovery(() => {
            const dialog = document.getElementById(dialogId)
            if (dialog instanceof HTMLElement && !dialog.contains(document.activeElement)) dialog.focus()
        })
    }, [visible, dialogId])

    const keyProps: WebKeyDownProps = Platform.OS === 'web'
        ? { onKeyDown: (event) => trapDialogTabFocus(dialogId, event) }
        : {}
    // React Native Web's Modal is already the dialog element (role and
    // aria-modal); naming it here avoids a second, nested dialog.
    const modalLabel = Platform.OS === 'web' ? ({ 'aria-labelledby': titleId } as object) : {}

    return (
        <Modal visible={visible} transparent animationType={bottomSheet ? 'slide' : 'fade'} onRequestClose={onClose} {...modalLabel}>
            <View style={[styles.scrim, bottomSheet ? styles.scrimBottom : styles.scrimCenter]}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
                <View
                    nativeID={dialogId}
                    tabIndex={-1}
                    accessibilityViewIsModal
                    style={[
                        styles.panel,
                        bottomSheet
                            ? [styles.panelBottom, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]
                            : styles.panelCenter,
                    ]}
                    {...keyProps}
                >
                    {bottomSheet ? <View style={styles.grabber} aria-hidden /> : null}
                    <View style={styles.header}>
                        <Text nativeID={titleId} style={[textStyles.rowTitle, styles.title]} numberOfLines={1}>{title}</Text>
                        <Pressable
                            onPress={onClose}
                            style={styles.close}
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                        >
                            <MaterialIcons name="close" size={20} color={colors.textSecondary} />
                        </Pressable>
                    </View>
                    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
                        {children}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    scrim: { flex: 1, backgroundColor: scrim },
    scrimBottom: { justifyContent: 'flex-end' },
    scrimCenter: { justifyContent: 'center', alignItems: 'center', padding: spacing['3xl'] },
    panel: {
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
        // The panel takes focus so keyboard users start inside it; it isn't a control, so no ring.
        ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}),
        ...elevation('xl'),
    },
    panelBottom: {
        width: '100%',
        maxHeight: '88%',
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
    },
    panelCenter: {
        width: '100%',
        maxWidth: 560,
        maxHeight: '86%',
        borderRadius: radii['2xl'],
    },
    grabber: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: radii.full,
        backgroundColor: colors.border,
        marginTop: spacing.sm,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingLeft: spacing.xl,
        paddingRight: spacing.sm,
        minHeight: 52,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    title: { flex: 1 },
    close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md },
    body: { flexGrow: 0 },
    bodyContent: { padding: spacing.xl },
})
