import { Platform, Share } from 'react-native'
import { showAlert, showSuccess } from '@/lib/alert'

export async function shareInviteMessage(message: string): Promise<void> {
    try {
        if (Platform.OS === 'web' && typeof navigator !== 'undefined' && typeof navigator.share !== 'function') {
            if (!navigator.clipboard?.writeText) {
                showAlert('Sharing unavailable', 'Copy the invite code shown on this page.')
                return
            }
            await navigator.clipboard.writeText(message)
            showSuccess('Copied', 'Invite message copied.')
            return
        }
        await Share.share({ message })
    } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return
        showAlert('Could not share invite', 'Copy the invite code shown on this page.')
    }
}
