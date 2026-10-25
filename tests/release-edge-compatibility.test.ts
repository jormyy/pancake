import { runInNewContext } from 'node:vm'
import ts from 'typescript'
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

function subscribedTables(source: string) {
    const direct = [...source.matchAll(/\.on\(\s*['"]postgres_changes['"]\s*,\s*\{[^}]*?\btable\s*:\s*['"]([a-z_]+)['"]/g)]
        .map(match => match[1])
    const watches = [...source.matchAll(/\bwatches\s*:\s*\[([\s\S]*?)\]/g)]
        .flatMap(match => [...match[1].matchAll(/\btable\s*:\s*['"]([a-z_]+)['"]/g)].map(table => table[1]))
    return new Set([...direct, ...watches])
}

function droppedSubscribedTables(migrations: string[], subscribed: Set<string>) {
    return migrations.flatMap(source => [...maskSqlNonCode(source).matchAll(/ALTER\s+PUBLICATION\s+supabase_realtime\s+DROP\s+TABLE\s+([^;]+);/gi)]
        .flatMap(statement => statement[1].split(',').map(table => table.trim().replace(/^public\./, '')))
        .filter(table => subscribed.has(table)))
}

it.skipIf(!available)('keeps deployed client subscriptions in the Realtime publication', () => {
    const files = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'app', 'components', 'contexts', 'hooks', 'lib').split('\n')
        .filter(file => /\.tsx?$/.test(file))
    const subscribed = subscribedTables(git('show', ...files.map(file => `origin/main:${file}`)))
    expect([...subscribed]).toEqual(expect.arrayContaining(['weekly_lineups', 'waiver_claims', 'waiver_wire_log']))
    expect(droppedSubscribedTables(releaseMigrations(), subscribed)).toEqual([])
})

it('detects publication drops used by the deployed client', () => {
    const subscribed = subscribedTables(`channel.on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_lineups' }, refresh)`)
    expect([...subscribedTables(`subscribeToTableChanges('roster', { watches: [{ table: 'waiver_claims' }] })`)]).toEqual(['waiver_claims'])
    expect(droppedSubscribedTables(['ALTER PUBLICATION supabase_realtime DROP TABLE public.weekly_lineups, public.bids;'], subscribed))
        .toEqual(['weekly_lineups'])
    expect(droppedSubscribedTables(['ALTER PUBLICATION supabase_realtime DROP TABLE public.bids;'], subscribed)).toEqual([])
})

function rpcNames(source: string) {
    return new Set([...source.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)].map(match => `public.${match[1]}`))
}

function parameters(definition: string) {
    const source = maskSqlNonCode(definition)
    const open = source.indexOf('(')
    const segments: string[] = []
    let depth = 1, start = open + 1
    for (let index = start; index < source.length; index++) {
        if (source[index] === '(') depth++
        if (source[index] === ')') depth--
        if (depth === 0 || source[index] === ',' && depth === 1) {
            segments.push(definition.slice(start, index).trim())
            start = index + 1
            if (depth === 0) break
        }
    }
    return segments.filter(Boolean).filter(segment => !/^OUT\b/i.test(segment)).map(segment => {
        const declaration = segment.replace(/^(?:IN|INOUT|VARIADIC)\s+/i, '')
        const [name, ...type] = declaration.split(/\s+/)
        return { name, type: type.join(' ').replace(/\s+(?:DEFAULT|=)[\s\S]*$/i, '').toLowerCase()
            .replace(/\bint\b/g, 'integer').replace(/\bbool\b/g, 'boolean'), optional: /\s(?:DEFAULT\s|=)/i.test(declaration) }
    })
}

function brokenRpcContracts(sources: string[], deployed: Map<string, string>, merged: Map<string, string>) {
    const called = new Set(sources.flatMap(source => [...rpcNames(source)]))
    return [...deployed].filter(([key]) => called.has(key.split('(')[0])).filter(([key, definition]) => {
        const oldParameters = parameters(definition)
        return ![...merged].some(([nextKey, nextDefinition]) => {
            if (nextKey.split('(')[0] !== key.split('(')[0]) return false
            const nextParameters = parameters(nextDefinition)
            return oldParameters.every(old => nextParameters.some(next => next.name === old.name && next.type === old.type))
                && nextParameters.every(next => next.optional || oldParameters.some(old => old.name === next.name && !old.optional))
        })
    }).map(([key]) => key)
}

it.skipIf(!available)('preserves deployed Edge and client RPC argument contracts', () => {
    const files = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/functions', 'app', 'components', 'contexts', 'hooks', 'lib')
        .split('\n').filter(file => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
    const deployed = canonicalDefinitions('origin/main')
    const merged = canonicalDefinitions()
    for (const group of ['supabase/functions/', 'client']) {
        const selected = files.filter(file => group === 'client' ? !file.startsWith('supabase/') : file.startsWith(group))
        const sources = [git('show', ...selected.map(file => `origin/main:${file}`))]
        expect(brokenRpcContracts(sources, deployed, merged), `${group} RPC contracts`).toEqual([])
    }
})

it('rejects a replacement RPC with a new required argument', () => {
    const deployed = latestFunctionDefinitionsInSource('CREATE FUNCTION public.offer(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    const broken = latestFunctionDefinitionsInSource('CREATE FUNCTION public.offer(p_id uuid, p_required text) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    expect(brokenRpcContracts(["db.rpc('offer', { p_id: id })"], deployed, broken)).toEqual(['public.offer'])
    const compatible = latestFunctionDefinitionsInSource("CREATE FUNCTION public.offer(p_id uuid, p_required text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$ SELECT; $$;")
    expect(brokenRpcContracts(["db.rpc('offer', { p_id: id })"], deployed, compatible)).toEqual([])
})

it('checks client-only RPC calls as well as Edge calls', () => {
    const deployed = latestFunctionDefinitionsInSource('CREATE FUNCTION public.client_only(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    expect(brokenRpcContracts(["db.rpc('edge_only')"], deployed, new Map())).toEqual([])
    expect(brokenRpcContracts(["db.rpc('client_only', { p_id: id })"], deployed, new Map())).toEqual(['public.client_only'])
})

function deployedHintReceiver() {
    const source = git('show', 'origin/main:lib/league-changes.ts').replace(/^import .*$/gm, 'const onSessionCachesCleared = () => {}')
    const exports: Record<string, unknown> = {}
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports })
    return exports.leagueChangeReceiver as (league: string, receive: (change: Record<string, unknown>) => void) => (row: Record<string, unknown>) => boolean
}

it.skipIf(!available)('emits only hint topics and inventory resources accepted by the deployed client', () => {
    const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()
        .map(file => readFileSync(`supabase/migrations/${file}`, 'utf8')).join('\n')
    const check = [...migrations.matchAll(/ADD\s+CONSTRAINT\s+league_change_hints_topic_check\s+CHECK\s*\(topic\s+IN\s*\(([^)]+)\)/gi)].at(-1)!
    const topics = [...check[1].matchAll(/'([^']+)'/g)].map(match => match[1])
    const emitter = readFileSync('supabase/sql/functions/by-name/private/emit_league_inventory_change.sql', 'utf8')
    const resources = [...new Set([...emitter.matchAll(/'resource'\s*,\s*'([^']+)'/g)].map(match => match[1]))]
    const league = '11111111-1111-4111-8111-111111111111'
    const season = '22222222-2222-4222-8222-222222222222'
    const receiver = deployedHintReceiver()
    for (const topic of topics) {
        const consume = receiver(league, () => {})
        expect.soft(consume({ league_id: league, topic, revision: 1, scopes: null, details: null }), topic).toBe(true)
    }
    for (const resource of resources) {
        const changes: Record<string, unknown>[] = []
        const consume = receiver(league, change => changes.push(change))
        const details = [{ resource, season_id: season, ...(['picks', 'priority', 'faab'].includes(resource) ? { member_id: season } : {}) }]
        for (const revision of [1, 2]) consume({ league_id: league, topic: 'inventory', revision, scopes: null, details })
        expect.soft(changes.at(-1)?.details, resource).toEqual(details)
    }
})

function requiresDatabaseFirst(mainMigrations: string, clientSource: string, notes: string) {
    const functions = latestFunctionDefinitionsInSource(mainMigrations)
    const newRpc = [...rpcNames(clientSource)].some(name => !functions.has(name))
    const newColumns = ['waiver_claims.to_ir', 'player_game_stats.is_home'].some(column => {
        const [table, name] = column.split('.')
        return clientSource.includes(name) && !new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${table}[\\s\\S]*?ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'i').test(mainMigrations)
    })
    const irArgument = clientSource.includes('p_to_ir') && !parameters(functions.get('public.add_free_agent_atomic') ?? '()').some(parameter => parameter.name === 'p_to_ir')
    return (newRpc || newColumns || irArgument) && !/^## Release order for this release$/m.test(notes)
}

it.skipIf(!available)('documents database-first release order for new client dependencies', () => {
    const mainFiles = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations').split('\n').filter(file => file.endsWith('.sql'))
    const main = git('show', ...mainFiles.map(file => `origin/main:${file}`))
    const files = git('ls-files', '--', 'app', 'components', 'contexts', 'hooks', 'lib').split('\n').filter(file => /\.tsx?$/.test(file))
    const source = files.map(file => readFileSync(file, 'utf8')).join('\n')
    const notes = readFileSync('supabase/RELEASE-DB.md', 'utf8')
    expect(requiresDatabaseFirst(main, source, notes)).toBe(false)
    expect(requiresDatabaseFirst(main, source, notes.replace(/^## Release order for this release$/m, '## Removed'))).toBe(true)
})
