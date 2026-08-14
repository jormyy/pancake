import { Platform } from 'react-native'

const WEB_FOCUS_RECOVERY_DELAYS = [0, 50, 150, 350, 700, 1200, 2000, 3000] as const

const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'switch', 'textbox'])

/**
 * Whether a delayed focus-recovery attempt may steal focus to `target`:
 * yes when nothing meaningful holds focus (or another tab does), no when the
 * user has moved on to an interactive/editable element.
 */
export function shouldRecoverFocus(target: HTMLElement) {
    const active = document.activeElement
    if (!active || active === target || active === document.body) return true
    if (!(active instanceof HTMLElement)) return false

    const role = active.getAttribute('role')
    if (role === 'tab') return true
    if (role && INTERACTIVE_ROLES.has(role)) return false
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return false
    return !active.isContentEditable
}

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
