import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { clientRealtimeTables, publicationDifference, publicationTables, repositoryPublicationTables } from './helpers/realtime-publication'

it('publishes exactly the tables watched by the current client', () => {
    expect(publicationDifference(clientRealtimeTables(), repositoryPublicationTables())).toEqual({ missing: [], unwatched: [] })
})

it('follows aliases and watch helpers without counting unused factories or unrelated table properties', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pancake-realtime-contract-'))
    try {
        mkdirSync(path.join(root, 'lib'))
        const sources = {
            'lib/realtime.ts': 'export function subscribeToTableChanges(name: string, options: unknown) { return options }',
            'lib/watches.ts': `function scope(league: string, watches: { table: string }[]) {
                return watches.map(watch => ({ ...watch, filter: league }))
            }
            export function active(league: string) { return scope(league, [{ table: 'trades' }]) }
            export function unused() { return [{ table: 'roster_transactions' }] }`,
            'client.ts': `import { subscribeToTableChanges as subscribe } from './lib/realtime'
            import { active } from './lib/watches'
            const style = { table: 'unused_style' }
            subscribe('trade', { watches: active('league') })
            subscribe('claims', { watches: ['member'].flatMap(member => [{ table: 'waiver_claims', filter: member }]) })
            const channel = { on: (...args: unknown[]) => args }
            channel.on('postgres_changes', { table: 'matchup_forecasts' })
            void import('./lib/realtime').then(({ subscribeToTableChanges }) => {
                subscribeToTableChanges('hints', { watches: [{ table: 'league_change_hints' }] })
            })`,
        }
        for (const [file, source] of Object.entries(sources)) writeFileSync(path.join(root, file), source)
        expect(clientRealtimeTables(root, Object.keys(sources).map(file => path.join(root, file)))).toEqual(['league_change_hints', 'matchup_forecasts', 'trades', 'waiver_claims'])
        writeFileSync(path.join(root, 'client.ts'), `import { subscribeToTableChanges } from './lib/realtime'
            const table = String(Date.now())
            subscribeToTableChanges('unknown', { watches: [{ table: table }] })`)
        expect(() => clientRealtimeTables(root, Object.keys(sources).map(file => path.join(root, file)))).toThrow('Cannot resolve realtime watch')
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

it('rejects both a missing subscription and an unwatched publication table', () => {
    expect(publicationDifference(['drafts', 'league_change_hints'], ['drafts'])).toEqual({ missing: ['league_change_hints'], unwatched: [] })
    expect(publicationDifference(['drafts'], ['drafts', 'matchups'])).toEqual({ missing: [], unwatched: ['matchups'] })
})

it('applies publication changes in migration order after the last replacement', () => {
    expect(publicationTables([
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.matchups;',
        'ALTER PUBLICATION supabase_realtime SET TABLE public.drafts, public.matchups;',
        'ALTER PUBLICATION supabase_realtime DROP TABLE public.matchups; ALTER PUBLICATION supabase_realtime ADD TABLE public.league_change_hints;',
    ])).toEqual(['drafts', 'league_change_hints'])
})

it('rejects a later publication change it cannot resolve statically', () => {
    expect(() => publicationTables([
        'ALTER PUBLICATION supabase_realtime SET TABLE public.drafts;',
        'DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.matchups; END $$;',
    ])).toThrow('Cannot resolve a later realtime publication change')
})
