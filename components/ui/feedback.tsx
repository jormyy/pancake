import { createContext, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useReducedMotion } from '@/components/Motion'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { breakpoints, colors, elevation, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { Button } from './Button'
import { focusableDialogElements, trapDialogTabFocus, type DialogKeyboardEvent } from './dialogFocus'
import { scheduleWebFocusRecovery } from './webFocus'

type ToastVariant = 'info' | 'success' | 'warning' | 'error'

type ToastInput = { message: string; title?: string; variant?: ToastVariant; duration?: number }
type Toast = Required<Omit<ToastInput, 'title'>> & { id: number; title?: string; leaving?: boolean }

type ConfirmInput = {
    title: string
    message?: string
    confirmText?: string
    cancelText?: string
    destructive?: boolean
}
type Confirmation = ConfirmInput & {
    id: number
    resolve: (value: boolean) => void
    result?: boolean
    opener: HTMLElement | null
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
    // Confirms follow the shared pop-up rule: up from the bottom on phones,
    // a centered window on wider screens.
    const bottomSheet = useWindowDimensions().width < breakpoints.compact
    const [toasts, setToasts] = useState<Toast[]>([])
    const reduced = useReducedMotion()
    const [confirmState, setConfirmState] = useState<Confirmation | null>(null)
    const [confirmVisible, setConfirmVisible] = useState(false)
    const activeConfirm = useRef<Confirmation | null>(null)
    const confirmQueue = useRef<Confirmation[]>([])
    const confirmSequence = useRef(0)
    const mounted = useRef(true)
    const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
    const dialogId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const dialogContainerId = `${dialogId}-confirm-dialog`
    const dialogTitleId = `${dialogId}-confirm-title`
    const dialogMessageId = `${dialogId}-confirm-message`

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.map((t) => t.id === id ? { ...t, leaving: true } : t))
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

    const advanceConfirm = useCallback(() => {
        if (!mounted.current || activeConfirm.current) return
        const next = confirmQueue.current.shift()
        if (!next) return
        activeConfirm.current = next
        setConfirmState(next)
        setConfirmVisible(true)
    }, [])

    const confirm = useCallback(
        (input: ConfirmInput) =>
            new Promise<boolean>((resolve) => {
                if (!mounted.current) { resolve(false); return }
                const opener = Platform.OS === 'web' && typeof document !== 'undefined'
                    && document.activeElement instanceof HTMLElement ? document.activeElement : null
                confirmQueue.current.push({ ...input, resolve, opener, id: ++confirmSequence.current })
                advanceConfirm()
            }),
        [advanceConfirm],
    )

    useEffect(() => {
        if (confirmState || activeConfirm.current?.result === undefined) return
        const completed = activeConfirm.current
        activeConfirm.current = null
        if (completed.opener?.isConnected) completed.opener.focus()
        completed.resolve(completed.result!)
        queueMicrotask(advanceConfirm)
    }, [confirmState, advanceConfirm])

    useEffect(() => {
        mounted.current = true
        const toastTimers = timers.current
        const queued = confirmQueue.current
        return () => {
            mounted.current = false
            activeConfirm.current?.resolve(false)
            activeConfirm.current = null
            queued.splice(0).forEach(request => request.resolve(false))
            toastTimers.forEach(timer => clearTimeout(timer))
            toastTimers.clear()
        }
    }, [])

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
        if (!confirmState || !confirmVisible || Platform.OS !== 'web' || typeof document === 'undefined') return
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
    }, [confirmState, confirmVisible, dialogContainerId])

    const closeConfirm = (result: boolean) => {
        const current = activeConfirm.current
        if (!current || current.result !== undefined) return
        current.result = result
        setConfirmVisible(false)
        if (Platform.OS !== 'web') setConfirmState(null)
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
                        <ToastView key={t.id} toast={t} onExited={() => setToasts(prev => prev.filter(item => item.id !== t.id))}>
                            <MaterialIcons name={meta.icon} size={20} color={meta.color} />
                            <View style={styles.toastBody}>
                                {t.title ? <Text style={styles.toastTitle}>{t.title}</Text> : null}
                                <Text style={styles.toastMessage}>{t.message}</Text>
                            </View>
                            <Pressable onPress={() => dismiss(t.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                                <MaterialIcons name="close" size={18} color={colors.textMuted} />
                            </Pressable>
                        </ToastView>
                    )
                })}
            </View>

            {(Platform.OS !== 'web' || confirmState) && <Modal
                visible={confirmVisible}
                transparent
                animationType={reduced ? 'none' : bottomSheet ? 'slide' : 'fade'}
                onRequestClose={() => closeConfirm(false)}
                onDismiss={() => {
                    if (activeConfirm.current?.id === confirmState?.id && activeConfirm.current?.result !== undefined) {
                        setConfirmState(null)
                    }
                }}
            >
                <Pressable style={[styles.dialogScrim, bottomSheet && styles.dialogScrimBottom]} onPress={() => closeConfirm(false)}>
                    <Pressable
                        nativeID={dialogContainerId}
                        style={[
                            styles.dialog,
                            bottomSheet && [styles.dialogBottom, { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.lg }],
                        ]}
                        onPress={() => {}}
                        role="dialog"
                        aria-modal
                        aria-labelledby={dialogTitleId}
                        aria-describedby={confirmState?.message ? dialogMessageId : undefined}
                        tabIndex={-1}
                        accessibilityViewIsModal
                        {...dialogKeyProps}
                    >
                        {bottomSheet ? <View style={styles.grabber} aria-hidden /> : null}
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
            </Modal>}
        </FeedbackContext.Provider>
    )
}


function ToastView({ toast, onExited, children }: { toast: Toast; onExited: () => void; children: ReactNode }) {
    const reduced = useReducedMotion()
    const [opacity] = useState(() => new Animated.Value(reduced ? 1 : 0))
    const finish = useRef(onExited)
    finish.current = onExited
    useEffect(() => {
        const animation = Animated.timing(opacity, {
            toValue: toast.leaving ? 0 : 1,
            duration: reduced ? 0 : toast.leaving ? 140 : 180,
            useNativeDriver: Platform.OS !== 'web',
        })
        animation.start(({ finished }) => { if (finished && toast.leaving) finish.current() })
        return () => animation.stop()
    }, [opacity, reduced, toast.leaving])
    return <Animated.View style={[styles.toast, { borderLeftColor: VARIANT_META[toast.variant].color, opacity }]}>{children}</Animated.View>
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
        // Focus lands here only as a fallback; it isn't a control, so no ring.
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
        ...(elevation('xl') as object),
    },
    dialogScrimBottom: { justifyContent: 'flex-end', padding: 0 },
    dialogBottom: {
        maxWidth: undefined,
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.xl,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
    },
    grabber: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: radii.full,
        backgroundColor: colors.border,
        marginBottom: spacing.md,
    },
    dialogTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    dialogMessage: { fontSize: fontSize.md, color: colors.textSecondary, lineHeight: 21 },
    dialogActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
    dialogBtn: { flex: 1 },
})
