import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { functionLifecycleEventsInSource, latestFunctionDefinitionsInSource, maskSqlNonCode } from '../scripts/check-db-function-sources.mjs'

const available = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { encoding: 'utf8' }).status === 0
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function releaseMigrations() {
    const deployed = new Set(git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations').split('\n'))
    const changed = new Set(git('diff', '--name-only', '--no-renames', 'origin/main', '--', 'supabase/migrations').split('\n'))
    return readdirSync('supabase/migrations').filter(file => file.endsWith('.sql'))
        .map(file => `supabase/migrations/${file}`).filter(file => !deployed.has(file) || changed.has(file))
        .map(file => readFileSync(file, 'utf8'))
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
