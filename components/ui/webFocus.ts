import { Platform } from 'react-native'

const WEB_FOCUS_RECOVERY_DELAYS = [0, 50, 150, 350, 700, 1200, 2000, 3000] as const

export function scheduleWebFocusRecovery(focus: () => void): () => void {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {}

    const timeoutIds: number[] = []
    let frame: number | null = null
    for (const delay of WEB_FOCUS_RECOVERY_DELAYS) {
        if (delay === 0) frame = window.requestAnimationFrame(focus)
        else timeoutIds.push(window.setTimeout(focus, delay))
    }

    return () => {
        if (frame != null) window.cancelAnimationFrame(frame)
        for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId)
    }
}
