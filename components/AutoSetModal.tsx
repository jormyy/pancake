import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

export function AutoSetModal({
    visible,
    onClose,
    onEditManually,
}: {
    visible: boolean
    onClose: () => void
    onEditManually: () => void
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title="Auto-set lineup">
            <Button
                title="Edit lineup manually"
                variant="ghost"
                onPress={onEditManually}
                accessibilityLabel="Edit lineup manually"
                fullWidth
            />
        </Sheet>
    )
}
