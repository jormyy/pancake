/** Accessibility props for an action that stays pressable so a tap can explain why it is unavailable. */
export function blockedActionProps(reason: string | null, busy = false) {
    return {
        accessibilityHint: reason ?? undefined,
        accessibilityState: { disabled: busy || reason != null },
    }
}
