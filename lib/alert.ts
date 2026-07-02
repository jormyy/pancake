import { Alert, Platform } from 'react-native'
import { feedbackBridge } from '@/components/ui/feedback'

type BrowserAlertWindow = Window & { __pancakeAlerts?: string[] }

export function getErrorMessage(e: unknown): string {
    if (e instanceof Error) return e.message
    if (typeof e === 'string') return e
    return String(e)
}

function captureBrowserAlert(title: string, message?: string) {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const alerts = (window as BrowserAlertWindow).__pancakeAlerts
    if (Array.isArray(alerts)) alerts.push(message ? `${title}\n\n${message}` : title)
}

/**
 * Info/error notice. Routes through the in-app toast/feedback system when a
 * FeedbackProvider is mounted; falls back to a native alert otherwise.
 * `variant` lets callers signal success vs error; defaults to error-styled.
 */
export function showAlert(title: string, message?: string, variant: 'info' | 'success' | 'error' = 'error') {
    const api = feedbackBridge.api
    if (api) {
        captureBrowserAlert(title, message)
        api.toast({ title, message: message ?? title, variant })
        return
    }
    if (Platform.OS === 'web') {
        window.alert(message ? `${title}\n\n${message}` : title)
    } else {
        Alert.alert(title, message)
    }
}

/** Success toast convenience. */
export function showSuccess(title: string, message?: string) {
    showAlert(title, message, 'success')
}

/**
 * Destructive confirmation. Routes through the in-app confirm dialog when a
 * FeedbackProvider is mounted; falls back to native Alert / window.confirm.
 */
export function confirmAction(
    title: string,
    message: string,
    onConfirm: () => void,
    confirmText = 'Confirm',
    destructive = true,
) {
    const api = feedbackBridge.api
    if (api) {
        void api.confirm({ title, message, confirmText, destructive }).then((ok) => {
            if (ok) onConfirm()
        })
        return
    }
    if (Platform.OS === 'web') {
        if (window.confirm(`${title}\n\n${message}`)) {
            onConfirm()
        }
    } else {
        Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel' },
            { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
        ])
    }
}
