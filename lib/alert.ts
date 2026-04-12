import { Alert, Platform } from 'react-native'

/** Simple info/error alert — works on both native and web. */
export function showAlert(title: string, message?: string) {
    if (Platform.OS === 'web') {
        window.alert(message ? `${title}\n\n${message}` : title)
    } else {
        Alert.alert(title, message)
    }
}

/**
 * Destructive confirmation dialog — Cancel vs confirmText.
 * Uses native Alert on iOS/Android, window.confirm on web.
 */
export function confirmAction(
    title: string,
    message: string,
    onConfirm: () => void,
    confirmText = 'Confirm',
) {
    if (Platform.OS === 'web') {
        if (window.confirm(`${title}\n\n${message}`)) {
            onConfirm()
        }
    } else {
        Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel' },
            { text: confirmText, style: 'destructive', onPress: onConfirm },
        ])
    }
}
