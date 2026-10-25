import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { functionLifecycleEventsInSource, latestFunctionDefinitionsInSource, maskSqlNonCode } from '../scripts/check-db-function-sources.mjs'

const available = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { encoding: 'utf8' }).status === 0
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()

function releaseMigrations() {
    const deployed = new Set(git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations').split('\n'))
    const changed = new Set(git('diff', '--name-only', '--no-renames', 'origin/main', '--', 'supabase/migrations').split('\n'))
    return readdirSync('supabase/migrations').filter(file => file.endsWith('.sql'))
        .map(file => `supabase/migrations/${file}`).filter(file => !deployed.has(file) || changed.has(file))
        .sort().map(file => readFileSync(file, 'utf8'))
}

it.skipIf(!available)('keeps deployed Edge RPCs available in every release migration', () => {
    const edge = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/functions').split('\n')
        .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map(file => ({ file, source: git('show', `origin/main:${file}`) }))
    const dropped = new Set(releaseMigrations().flatMap(source => {
        const replaced = new Set([...latestFunctionDefinitionsInSource(source).keys()].map(key => key.split('(')[0]))
        return functionLifecycleEventsInSource(source).filter(event => event.type === 'drop' && !replaced.has(event.key)).map(event => event.key)
    }))
    const broken = edge.flatMap(({ file, source }) => [...source.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)]
        .filter(match => dropped.has(`public.${match[1]}`)).map(match => `${file}: ${match[1]}`))
    expect(broken, `Dropped release functions: ${[...dropped].join(', ')}`).toEqual([])
})

it.skipIf(!available)('keeps deployed Edge profile and receipt columns through the database phase', () => {
    const changes = releaseMigrations().map(source => maskSqlNonCode(source)).join('\n')
    const used = new Set(['profiles.push_token', 'profiles.push_token_revocation_hash',
        'notification_outbox.expo_ticket_id', 'notification_outbox.push_token',
        'notification_outbox.ticketed_at', 'notification_outbox.receipt_attempt_count'])
    const dropped = [...changes.matchAll(/ALTER\s+TABLE\s+(?:public\.)?(profiles|notification_outbox)\s+([^;]+);/gi)]
        .flatMap(statement => [...statement[2].matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_]+)/gi)]
            .map(column => `${statement[1]}.${column[1]}`)).filter(column => used.has(column))
    expect(dropped).toEqual([])
})

function duplicateVersions(files: string[]) {
    const byVersion = new Map<string, string[]>()
    for (const file of files.filter(file => file.endsWith('.sql'))) {
        const version = file.split('_')[0]
        byVersion.set(version, [...byVersion.get(version) ?? [], file])
    }
    return [...byVersion.values()].filter(files => files.length > 1)
}

function revertedDefinitions(migrations: string[], deployed: Map<string, string>, merged: Map<string, string>) {
    const release = latestFunctionDefinitionsInSource(migrations.join('\n'))
    return [...release].filter(([key, definition]) => deployed.has(key) && definition !== merged.get(key))
        .map(([key]) => key)
}

function canonicalDefinitions(revision?: string) {
    const files = revision
        ? git('ls-tree', '-r', '--name-only', revision, '--', 'supabase/sql/functions').split('\n')
        : readdirSync('supabase/sql/functions/by-name', { recursive: true })
            .map(file => `supabase/sql/functions/by-name/${file}`)
    const sqlFiles = files.filter(file => file.endsWith('.sql'))
    return latestFunctionDefinitionsInSource(revision
        ? git('show', ...sqlFiles.map(file => `${revision}:${file}`))
        : sqlFiles.map(file => readFileSync(file, 'utf8')).join('\n'))
}

it('requires origin/main when CI runs release compatibility checks', () => {
    expect(!process.env.CI || available, 'CI must fetch origin/main before checking deployed Edge compatibility').toBe(true)
})

it('rejects duplicate migration versions', () => {
    expect(duplicateVersions(readdirSync('supabase/migrations'))).toEqual([])
    expect(duplicateVersions(['20261024000001_main.sql', '20261024000001_release.sql']))
        .toEqual([['20261024000001_main.sql', '20261024000001_release.sql']])
})

it.skipIf(!available)('keeps merged bodies when release migrations redefine deployed functions', () => {
    expect(revertedDefinitions(releaseMigrations(), canonicalDefinitions('origin/main'), canonicalDefinitions()),
        'A release migration replaces a deployed function without the merged canonical body').toEqual([])
})

it('detects a release definition that would revert main', () => {
    const statement = (value: number) => `CREATE OR REPLACE FUNCTION public.shared_release_function() RETURNS integer LANGUAGE sql AS $$ SELECT ${value}; $$;`
    const deployed = latestFunctionDefinitionsInSource(statement(2))
    const merged = latestFunctionDefinitionsInSource(statement(3))
    expect(revertedDefinitions([statement(1)], deployed, merged)).toEqual(['public.shared_release_function'])
    expect(revertedDefinitions([statement(1), statement(3)], deployed, merged)).toEqual([])
})
