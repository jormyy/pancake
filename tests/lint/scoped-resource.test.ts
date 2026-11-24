import path from 'path'
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../..') })

async function scopedResourceMessages(code: string, filePath = 'hooks/probe.ts') {
    const [result] = await eslint.lintText(code, { filePath })
    return result.messages.filter(message => message.ruleId === 'pancake/scoped-resource').map(message => message.message)
}

it('accepts state committed through a scope ticket', async () => {
    expect(await scopedResourceMessages(`import { useState } from 'react'
import { useScope } from '@/hooks/use-scope'
export function useLineup(leagueId: string, read: (id: string) => Promise<string>) {
    const scope = useScope(leagueId)
    const [lineup, setLineup] = useState<string | null>(null)
    const load = async () => {
        setLineup(null)
        const ticket = scope.latest()
        const value = await read(leagueId)
        ticket.commit(() => setLineup(value))
    }
    return { lineup, load }
}
`)).toEqual([])
})

it('rejects the lineup commit that showed the previous league at 6b8826ae', async () => {
    const messages = await scopedResourceMessages(`import { useState } from 'react'
export function useMatchupData(leagueId: string, getWeeklyLineup: (league: string) => Promise<string>) {
    const [myLineup, setMyLineup] = useState<string | null>(null)
    const loadMyLineup = async () => {
        const data = await getWeeklyLineup(leagueId)
        setMyLineup(data)
    }
    return { myLineup, loadMyLineup }
}
`)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('ticket.commit')
})

it('rejects promise callbacks and hand-rolled fences in screens', async () => {
    const messages = await scopedResourceMessages(`import { useEffect, useRef, useState } from 'react'
export default function Feed({ read }: { read: () => Promise<string[]> }) {
    const loadSeqRef = useRef(0)
    const [rows, setRows] = useState<string[]>([])
    useEffect(() => { void read().then(next => setRows(next)) }, [read])
    return rows.length + loadSeqRef.current
}
`, 'app/(tabs)/probe.tsx')
    expect(messages).toHaveLength(2)
    expect(messages.some(message => message.includes('useScope'))).toBe(true)
})
