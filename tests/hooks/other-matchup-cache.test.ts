import { boundary, bumpView } from '../helpers/screen-view-boundary'
import { homePayload } from '../helpers/home-view-fixture'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
let latest: ReturnType<typeof useMatchupData>
function Probe({ id }: { id?: string }) {
    latest = useMatchupData({ id: 'member' }, { id: 'account' }, { id: 'league' }, true, null, undefined, id)
    return null
}
async function render(id?: string) { await act(async () => { if (screen) screen.update(React.createElement(Probe, { id })); else screen = create(React.createElement(Probe, { id })) }) }
async function unmount() { await act(async () => screen?.unmount()); screen = undefined }
beforeEach(() => { boundary.read.mockImplementation(async scope => ({ ...homePayload(String(scope.params.date)), matchup: { ...homePayload().matchup, id: scope.params.matchupId ?? 'own' } })); })
afterEach(unmount)
it('reads each other matchup once and sends zero view requests on reopen', async () => {
    await render('other-a')
    expect(latest.matchup?.id).toBe('other-a')
    expect(boundary.read).toHaveBeenCalledOnce()
    await unmount(); await render('other-a')
    expect(boundary.read).toHaveBeenCalledOnce()
    await render('other-b')
    expect(latest.matchup?.id).toBe('other-b')
    expect(boundary.read).toHaveBeenCalledTimes(2)
    await render('other-a')
    expect(latest.matchup?.id).toBe('other-a')
    expect(boundary.read).toHaveBeenCalledTimes(2)
    await render()
    expect(latest.matchup?.id).toBe('own')
    expect(boundary.read).toHaveBeenCalledTimes(3)
})
it('keys selected days separately and reuses them on return', async () => {
    await render('other-a')
    const originalDate = latest.selectedDate
    await act(async () => latest.setSelectedDate('2026-11-12'))
    expect(boundary.read).toHaveBeenCalledTimes(2)
    expect(boundary.read.mock.calls[1][0].params).toEqual({ date: '2026-11-12', matchupId: 'other-a' })
    await act(async () => latest.setSelectedDate(originalDate))
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
it('revalidates an opened other matchup after a score change', async () => {
    await render('other-a')
    await act(async () => { await bumpView('league', 'score') })
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
