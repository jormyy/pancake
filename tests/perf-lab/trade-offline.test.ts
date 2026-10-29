import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { boundary } from '../helpers/screen-view-boundary'
import { tradePayload } from '../helpers/trade-view-fixture'
import { saveScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { useTradesFeed } from '@/hooks/use-trades-feed'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('hydrates saved offers before the session registry is initialized on an offline reload', async () => {
  boundary.online = false
  ;(boundary as { owner: string | undefined }).owner = undefined
  saveScreenView(screenScope('trades', 'league', 'member', { tab: 'offers', limit: 40 }, 'account'), tradePayload(['saved-offer']), '1')
  let feed!: ReturnType<typeof useTradesFeed>
  const Probe = () => { feed = useTradesFeed('member', 'league', false, { accountId: 'account' }); return null }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Probe)) })
  try {
    expect(feed.trades.map(row => row.id)).toEqual(['saved-offer'])
    expect(feed.hasData).toBe(true)
    expect(boundary.read).not.toHaveBeenCalled()
  } finally { await act(async () => renderer.unmount()) }
})
