import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import Animated, { FadeIn, FadeOut, SlideInUp, SlideOutUp } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, elevation, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { Button } from './Button'
import { focusableDialogElements, trapDialogTabFocus, type DialogKeyboardEvent } from './dialogFocus'
import { scheduleWebFocusRecovery } from './webFocus'

type ToastVariant = 'info' | 'success' | 'warning' | 'error'

type ToastInput = { message: string; title?: string; variant?: ToastVariant; duration?: number }
type Toast = Required<Omit<ToastInput, 'title'>> & { id: number; title?: string }

type ConfirmInput = {
    title: string
    message?: string
    confirmText?: string
    cancelText?: string
    destructive?: boolean
}
type WebKeyDownProps = {
    onKeyDown?: (event: DialogKeyboardEvent) => void
}

type FeedbackApi = {
    toast: (input: ToastInput) => void
    success: (message: string, title?: string) => void
    error: (message: string, title?: string) => void
    info: (message: string, title?: string) => void
    confirm: (input: ConfirmInput) => Promise<boolean>
}

const FeedbackContext = createContext<FeedbackApi | null>(null)

// Module-level bridge so non-React code (lib/alert.ts) can reach the mounted
// provider. Falls back to native dialogs when no provider is mounted.
export const feedbackBridge: { api: FeedbackApi | null } = { api: null }

const VARIANT_META: Record<ToastVariant, { icon: ComponentIcon; color: string; bg: string }> = {
    info: { icon: 'info', color: colors.accent, bg: colors.bgCard },
    success: { icon: 'check-circle', color: colors.success, bg: colors.bgCard },
    warning: { icon: 'warning', color: colors.warning, bg: colors.bgCard },
    error: { icon: 'error', color: colors.danger, bg: colors.bgCard },
}
type ComponentIcon = 'info' | 'check-circle' | 'warning' | 'error'

let toastSeq = 1

export function FeedbackProvider({ children }: { children: ReactNode }) {
    const insets = useSafeAreaInsets()
    const [toasts, setToasts] = useState<Toast[]>([])
    const [confirmState, setConfirmState] = useState<(ConfirmInput & { resolve: (v: boolean) => void }) | null>(null)
    const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
    const dialogId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const dialogContainerId = `${dialogId}-confirm-dialog`
    const dialogTitleId = `${dialogId}-confirm-title`
    const dialogMessageId = `${dialogId}-confirm-message`

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
        const timer = timers.current.get(id)
        if (timer) {
            clearTimeout(timer)
            timers.current.delete(id)
        }
    }, [])

    const toast = useCallback(
        (input: ToastInput) => {
            const variant = input.variant ?? 'info'
            const duration = input.duration ?? (variant === 'error' ? 6000 : 4200)
            const id = toastSeq++
            setToasts((prev) => [...prev.slice(-2), { id, message: input.message, title: input.title, variant, duration }])
            timers.current.set(id, setTimeout(() => dismiss(id), duration))
        },
        [dismiss],
    )

    const confirm = useCallback(
        (input: ConfirmInput) =>
            new Promise<boolean>((resolve) => {
                setConfirmState({ ...input, resolve })
            }),
        [],
    )

    const api = useMemo<FeedbackApi>(
        () => ({
            toast,
            success: (message, title) => toast({ message, title, variant: 'success' }),
            error: (message, title) => toast({ message, title, variant: 'error' }),
            info: (message, title) => toast({ message, title, variant: 'info' }),
            confirm,
        }),
        [toast, confirm],
    )

    useEffect(() => {
        feedbackBridge.api = api
        return () => {
            if (feedbackBridge.api === api) feedbackBridge.api = null
        }
    }, [api])

    useEffect(() => {
        if (!confirmState || Platform.OS !== 'web' || typeof document === 'undefined') return
        const focusDialog = () => {
            const dialog = document.getElementById(dialogContainerId)
            if (!(dialog instanceof HTMLElement)) return
            // Once focus is inside the dialog (user tabbed to Confirm, or a
            // recovery already landed), leave it alone — the delayed retries
            // only exist to win against RN Modal's own focus juggling.
            if (dialog.contains(document.activeElement)) return
            // Cancel renders first in the actions row, so initial focus lands
            // on the safe action instead of the dialog container div.
            const firstAction = focusableDialogElements(dialog)[0]
            if (firstAction) firstAction.focus()
            else dialog.focus()
        }
        return scheduleWebFocusRecovery(focusDialog)
    }, [confirmState, dialogContainerId])

    const closeConfirm = (result: boolean) => {
        confirmState?.resolve(result)
        setConfirmState(null)
    }
    const dialogKeyProps: WebKeyDownProps = Platform.OS === 'web'
        ? { onKeyDown: (event) => trapDialogTabFocus(dialogContainerId, event) }
        : {}

    return (
        <FeedbackContext.Provider value={api}>
            {children}
            <View style={[styles.toastHost, { top: insets.top + spacing.lg }]}>
                {toasts.map((t) => {
                    const meta = VARIANT_META[t.variant]
                    return (
                        <Animated.View
                            key={t.id}
                            entering={Platform.OS === 'web' ? FadeIn.duration(180) : SlideInUp.duration(220)}
                            exiting={Platform.OS === 'web' ? FadeOut.duration(140) : SlideOutUp.duration(180)}
                            style={[styles.toast, { borderLeftColor: meta.color }]}
                        >
                            <MaterialIcons name={meta.icon} size={20} color={meta.color} />
                            <View style={styles.toastBody}>
                                {t.title ? <Text style={styles.toastTitle}>{t.title}</Text> : null}
                                <Text style={styles.toastMessage}>{t.message}</Text>
                            </View>
                            <Pressable onPress={() => dismiss(t.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                                <MaterialIcons name="close" size={18} color={colors.textMuted} />
                            </Pressable>
                        </Animated.View>
                    )
                })}
            </View>

            <Modal visible={!!confirmState} transparent animationType="fade" onRequestClose={() => closeConfirm(false)}>
                <Pressable style={styles.dialogScrim} onPress={() => closeConfirm(false)}>
                    <Pressable
                        nativeID={dialogContainerId}
                        style={styles.dialog}
                        onPress={() => {}}
                        role="dialog"
                        aria-modal
                        aria-labelledby={dialogTitleId}
                        aria-describedby={confirmState?.message ? dialogMessageId : undefined}
                        tabIndex={-1}
                        accessibilityViewIsModal
                        {...dialogKeyProps}
                    >
                        <Text nativeID={dialogTitleId} style={styles.dialogTitle}>{confirmState?.title}</Text>
                        {confirmState?.message ? (
                            <Text nativeID={dialogMessageId} style={styles.dialogMessage}>{confirmState.message}</Text>
                        ) : null}
                        <View style={styles.dialogActions}>
                            <Button
                                title={confirmState?.cancelText ?? 'Cancel'}
                                variant="secondary"
                                onPress={() => closeConfirm(false)}
                                style={styles.dialogBtn}
                            />
                            <Button
                                title={confirmState?.confirmText ?? 'Confirm'}
                                variant={confirmState?.destructive ? 'danger' : 'primary'}
                                onPress={() => closeConfirm(true)}
                                style={styles.dialogBtn}
                            />
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </FeedbackContext.Provider>
    )
}

export function useFeedback(): FeedbackApi {
    const ctx = useContext(FeedbackContext)
    if (!ctx) throw new Error('useFeedback must be used within FeedbackProvider')
    return ctx
}

const styles = StyleSheet.create({
    toastHost: {
        position: Platform.OS === 'web' ? ('fixed' as 'absolute') : 'absolute',
        pointerEvents: 'box-none',
        left: 0,
        right: 0,
        alignItems: 'center',
        gap: spacing.md,
        zIndex: 9999,
        paddingHorizontal: spacing.lg,
    },
    toast: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        maxWidth: 440,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderLeftWidth: 4,
        backgroundColor: colors.bgCard,
        ...(elevation('lg') as object),
    },
    toastBody: { flex: 1, gap: 1 },
    toastTitle: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    toastMessage: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 18 },

    dialogScrim: {
        flex: 1,
        backgroundColor: scrim,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xl,
    },
    dialog: {
        width: '100%',
        maxWidth: 420,
        backgroundColor: colors.bgCard,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        padding: spacing['3xl'],
        gap: spacing.md,
        ...(elevation('xl') as object),
    },
    dialogTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    dialogMessage: { fontSize: fontSize.md, color: colors.textSecondary, lineHeight: 21 },
    dialogActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
    dialogBtn: { flex: 1 },
})
