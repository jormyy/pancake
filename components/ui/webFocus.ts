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

export function keepScrollOnFocusReturn(opener: HTMLElement, windowMs = 1500, settleMs = 250): () => void {
    if (typeof window === 'undefined') return () => {}
    const onFocus = () => {
        stop()
        const saved = new Map<HTMLElement, number>()
        for (let node = opener.parentElement; node; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight) saved.set(node, node.scrollTop)
        }
        const onScroll = (event: Event) => {
            const node = event.target
            if (!(node instanceof HTMLElement)) return
            const top = saved.get(node)
            if (top === undefined) return
            document.removeEventListener('scroll', onScroll, true)
            const shift = node.scrollTop - top
            if (!shift) return
            const box = node.getBoundingClientRect()
            const target = opener.getBoundingClientRect()
            const shownNow = target.top >= box.top && target.bottom <= box.bottom
            const clippedBefore = target.top + shift < box.top || target.bottom + shift > box.bottom
            const partlyShownBefore = target.bottom + shift > box.top && target.top + shift < box.bottom
            if (shownNow && clippedBefore && partlyShownBefore) node.scrollTop = top
        }
        document.addEventListener('scroll', onScroll, true)
        window.setTimeout(() => document.removeEventListener('scroll', onScroll, true), settleMs)
    }
    const timer = window.setTimeout(() => stop(), windowMs)
    const stop = () => {
        window.clearTimeout(timer)
        opener.removeEventListener('focus', onFocus)
    }
    opener.addEventListener('focus', onFocus)
    return stop
}
