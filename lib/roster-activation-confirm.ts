import { confirmAction } from '@/lib/alert'

const TAXI_NOTICE = ' They cannot return to your team’s taxi, even after reacquisition or a season change. Another team can still acquire them into taxi if eligible.'

export function confirmRosterActivation({ source, reserveName, freeing }: {
    source: 'ir' | 'taxi'
    reserveName: string
    freeing?: { name: string; action: 'drop' | 'ir' }
}, onConfirm: () => void) {
    const notice = source === 'taxi' ? TAXI_NOTICE : ''
    if (freeing) {
        const drop = freeing.action === 'drop'
        confirmAction(
            drop ? `Drop ${freeing.name}?` : `Move ${freeing.name} to IR?`,
            `${drop ? `Drop ${freeing.name}` : `Move ${freeing.name} to IR`} to activate ${reserveName}?${notice}`,
            onConfirm,
            drop ? 'Drop and activate' : 'Move and activate',
            drop || source === 'taxi',
        )
        return
    }
    confirmAction(
        source === 'taxi' ? 'Activate from Taxi?' : 'Activate from IR?',
        `Move ${reserveName} to your active roster?${notice}`,
        onConfirm,
        'Confirm',
        source === 'taxi',
    )
}
