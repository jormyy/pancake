import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { playerRow } from './helpers/fixtures'

// Render budget for list rows: when one row starts an add, only that row (and
// the row that stopped) may re-render. Every row re-rendering on each state
// change is what makes long lists feel sticky on phones.

const renders = vi.hoisted(() => ({ avatar: 0 }))
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: { BlobModule: null },
    StyleSheet: { create: (styles: unknown) => styles },
    Image: 'Image',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({
    Avatar: () => { renders.avatar += 1; return null },
}))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/projections', () => ({ formatProjectionGame: () => null, numberOrDash: String }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS = 20
const players = Array.from({ length: ROWS }, (_, index) => playerRow({ id: `player-${index}`, display_name: `Player ${index}` }))
// The screen memoizes these across renders; the rows are what is under test.
const stableProps = {
    currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), gamesLeft: new Map(),
    animate: false, onAdd: () => {}, onPress: () => {},
}

let renderer: ReactTestRenderer | null = null
let setAdding!: (value: string | null) => void

function List() {
    const [adding, update] = useState<string | null>(null)
    setAdding = update
    return React.createElement(React.Fragment, null, players.map((item) => React.createElement(PlayerSearchItem, {
        key: item.id, item, isAdding: adding === item.id, ...stableProps,
    })))
}

beforeEach(() => { renders.avatar = 0 })
afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

describe('player list render budget', () => {
    it('re-renders only the rows whose add state changed', async () => {
        await act(async () => { renderer = create(React.createElement(List)) })
        expect(renders.avatar).toBe(ROWS)

        renders.avatar = 0
        await act(async () => { setAdding('player-3') })
        const startRenders = renders.avatar

        renders.avatar = 0
        await act(async () => { setAdding(null) })
        const stopRenders = renders.avatar

        expect({ startRenders, stopRenders }).toEqual({ startRenders: 1, stopRenders: 1 })
    })
})
