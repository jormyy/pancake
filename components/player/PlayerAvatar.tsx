import type { ComponentProps } from 'react'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'

type Props = Omit<ComponentProps<typeof Avatar>, 'uri'> & { nbaId?: string | null }

export function PlayerAvatar({ nbaId, ...props }: Props) {
    const uri = nbaId && /^\d{3,10}$/.test(nbaId) ? playerHeadshotUrl(nbaId) : null
    return <Avatar {...props} uri={uri} />
}
