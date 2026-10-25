import { Platform } from 'react-native'

type SwitchKeyboardEvent = {
    key: string
    repeat?: boolean
    preventDefault: () => void
}

type SwitchKeyboardProps = {
    onKeyDown?: (event: SwitchKeyboardEvent) => void
}

export function notificationSwitchKeyboardProps(onPress: () => void, disabled = false): SwitchKeyboardProps {
    if (Platform.OS !== 'web') return {}
    return {
        onKeyDown(event) {
            if (event.key !== ' ') return
            event.preventDefault()
            if (!disabled && !event.repeat) onPress()
        },
    }
}
