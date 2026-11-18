import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { IrNotices } from '@/components/lineup/IrNotices'

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it('names the player, the reason in plain words and the legal action', async () => {
    await act(async () => {
        screen = create(React.createElement(IrNotices, {
            notices: [{
                playerId: 'p1', playerName: 'Injured Star', reason: 'healthy_ir_bench_full',
                action: 'Drop a player, then activate Injured Star',
            }],
        }))
    })
    const text = JSON.stringify(screen.toJSON())
    expect(text).toContain('Injured Star')
    expect(text).toContain('Healthy on IR, but the active roster is full.')
    expect(text).toContain('Drop a player, then activate Injured Star')
})

it('explains an uncertain IR choice and a taxi problem in plain words', async () => {
    await act(async () => {
        screen = create(React.createElement(IrNotices, {
            notices: [
                { playerId: 'p1', playerName: 'Injured Star', reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' },
                { playerId: 'p2', playerName: 'Taxi Guy', reason: 'taxi_ineligible', action: 'Activate Taxi Guy from taxi or drop a player' },
            ],
        }))
    })
    const text = JSON.stringify(screen.toJSON())
    expect(text).toContain('Injured players are competing for the last IR spot and their return dates are unclear.')
    expect(text).toContain('Choose who moves to IR')
    expect(text).toContain('No longer eligible for the taxi squad.')
    expect(text).toContain('Activate Taxi Guy from taxi or drop a player')
})

it('renders nothing when the optimizer returned no notices', async () => {
    await act(async () => { screen = create(React.createElement(IrNotices, { notices: [] })) })
    expect(screen.toJSON()).toBeNull()
})
