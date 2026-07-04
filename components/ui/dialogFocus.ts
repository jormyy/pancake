export type DialogKeyboardEvent = {
    key: string
    shiftKey?: boolean
    preventDefault?: () => void
}

const DIALOG_FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="button"]:not([aria-disabled="true"])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

export function focusableDialogElements(dialog: HTMLElement) {
    return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null || element.getClientRects().length > 0)
}

export function nextDialogFocusIndex(activeIndex: number, count: number, shiftKey = false): number | null {
    if (count <= 0) return null
    if (shiftKey) return activeIndex <= 0 ? count - 1 : activeIndex - 1
    return activeIndex < 0 || activeIndex >= count - 1 ? 0 : activeIndex + 1
}

export function trapDialogTabFocus(dialogContainerId: string, event: DialogKeyboardEvent) {
    if (event.key !== 'Tab' || typeof document === 'undefined') return

    const dialog = document.getElementById(dialogContainerId)
    if (!(dialog instanceof HTMLElement)) return

    const focusableElements = focusableDialogElements(dialog)
    event.preventDefault?.()

    const nextIndex = nextDialogFocusIndex(
        focusableElements.indexOf(document.activeElement as HTMLElement),
        focusableElements.length,
        event.shiftKey,
    )
    if (nextIndex == null) {
        dialog.focus()
        return
    }
    focusableElements[nextIndex]?.focus()
}
