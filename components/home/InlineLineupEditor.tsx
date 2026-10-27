import { LineupEditor } from '@/app/(modals)/lineup'
import { ScreenStatusProvider } from '@/components/ui/ScreenStatusOverlay'

export function InlineLineupEditor() {
    return <ScreenStatusProvider><LineupEditor inline /></ScreenStatusProvider>
}
