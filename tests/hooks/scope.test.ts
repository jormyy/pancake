import React, { useEffect, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useScope } from '@/hooks/use-scope'
import { setSessionOwner } from '@/lib/session-cache-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reads = new Map<string, { promise: Promise<string>; resolve: (value: string) => void }[]>()

function read(key: string) {
    let resolve!: (value: string) => void
    const promise = new Promise<string>(done => { resolve = done })
    reads.set(key, [...reads.get(key) ?? [], { promise, resolve }])
    return promise
}

const shown: (string | null)[] = []
const committed: string[] = []
let reload!: () => void

function Lineup({ leagueId, newest = false }: { leagueId: string; newest?: boolean }) {
    const scope = useScope(leagueId)
    const [lineup, setLineup] = useState<string | null>(null)
    useEffect(() => {
        const load = async () => {
            const ticket = newest ? scope.latest() : scope.ticket()
            const value = await read(leagueId)
            ticket.commit(() => { committed.push(value); setLineup(value) })
        }
        reload = () => { void load() }
        void load()
    }, [leagueId, newest, scope])
    shown.push(lineup)
    return null
}

async function settle(key: string, index: number, value: string) {
    await act(async () => { reads.get(key)![index].resolve(value) })
}

let renderer: ReactTestRenderer

beforeEach(() => {
    reads.clear()
    shown.length = 0
    committed.length = 0
    setSessionOwner('owner-a')
})

afterEach(async () => { await act(async () => renderer?.unmount()) })

it('never shows league A after the screen moved to league B', async () => {
    await act(async () => { renderer = create(React.createElement(Lineup, { leagueId: 'league-a' })) })
    await act(async () => { renderer.update(React.createElement(Lineup, { leagueId: 'league-b' })) })
    await settle('league-b', 0, 'B lineup')
    await settle('league-a', 0, 'A lineup')
    expect(shown.at(-1)).toBe('B lineup')
    expect(shown).not.toContain('A lineup')
})

it('drops an older load that a newer load in the same scope replaced', async () => {
    await act(async () => { renderer = create(React.createElement(Lineup, { leagueId: 'league-a', newest: true })) })
    await act(async () => { reload() })
    await settle('league-a', 1, 'new')
    await settle('league-a', 0, 'old')
    expect(shown.at(-1)).toBe('new')
})

it('drops a load that finishes after the account changed', async () => {
    await act(async () => { renderer = create(React.createElement(Lineup, { leagueId: 'league-a' })) })
    setSessionOwner('owner-b')
    await settle('league-a', 0, 'owner A lineup')
    expect(shown).not.toContain('owner A lineup')
})

it('drops a load that finishes after the screen closed', async () => {
    await act(async () => { renderer = create(React.createElement(Lineup, { leagueId: 'league-a' })) })
    await act(async () => renderer.unmount())
    await settle('league-a', 0, 'late')
    expect(committed).not.toContain('late')
})
