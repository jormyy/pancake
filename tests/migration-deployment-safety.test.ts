import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDirectory = path.join(process.cwd(), 'supabase/migrations')
const read = (filename: string) => readFileSync(path.join(migrationsDirectory, filename), 'utf8')
const topLevelStatements = (source: string): string[] => {
    const statements: string[] = []
    let current = ''
    let dollarQuote: string | null = null
    let singleQuoted = false
    let doubleQuoted = false
    let lineComment = false
    let blockComment = false

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index]
        const next = source[index + 1]
        if (lineComment) {
            if (char === '\n') lineComment = false
            continue
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false
                index += 1
            }
            continue
        }
        if (dollarQuote) {
            if (source.startsWith(dollarQuote, index)) {
                current += dollarQuote
                index += dollarQuote.length - 1
                dollarQuote = null
            }
            continue
        }
        if (singleQuoted) {
            current += char
            if (char === "'" && next === "'") current += source[index += 1]
            else if (char === "'") singleQuoted = false
            continue
        }
        if (doubleQuoted) {
            current += char
            if (char === '"' && next === '"') current += source[index += 1]
            else if (char === '"') doubleQuoted = false
            continue
        }
        if (char === '-' && next === '-') {
            lineComment = true
            index += 1
            continue
        }
        if (char === '/' && next === '*') {
            blockComment = true
            index += 1
            continue
        }
        if (char === "'") singleQuoted = true
        else if (char === '"') doubleQuoted = true
        else if (char === '$') {
            const delimiter = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]
            if (delimiter) {
                dollarQuote = delimiter
                current += delimiter
                index += delimiter.length - 1
                continue
            }
        }
        if (char === ';') {
            if (current.trim()) statements.push(current.trim())
            current = ''
        } else current += char
    }
    if (current.trim()) statements.push(current.trim())
    return statements
}
const lockTakingStatement = (statement: string) => /^(?:ALTER\s+TABLE|DROP\s+(?:TABLE|TRIGGER|INDEX|POLICY|FUNCTION|TYPE)|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+(?:TRIGGER|POLICY)|INSERT\s+INTO|UPDATE\s+(?!pg_temp\.)|DELETE\s+FROM|TRUNCATE)/i.test(statement)
const lockTakingStatements = (source: string) => topLevelStatements(source).filter(lockTakingStatement)
const bounded = (source: string) => {
    const statements = topLevelStatements(source)
    const mutations = statements.map((statement, index) => lockTakingStatement(statement) ? index : -1)
        .filter((index) => index >= 0)
    if (mutations.length === 0) return false
    const lockTimeout = statements.findIndex((statement) => statement === "SET lock_timeout = '5s'")
    const statementTimeout = statements.findIndex((statement) =>
        /^SET statement_timeout = '(?:[1-9]\d*(?:ms|s|min|h))'$/.test(statement))
    const statementReset = statements.findLastIndex((statement) => statement === 'RESET statement_timeout')
    const lockReset = statements.findLastIndex((statement) => statement === 'RESET lock_timeout')
    return lockTimeout >= 0 && statementTimeout >= 0 &&
        lockTimeout < mutations[0] && statementTimeout < mutations[0] &&
        statementReset > mutations.at(-1)! && lockReset > mutations.at(-1)!
}
const onlineRouteConstraintSequence = (source: string, route: 'from' | 'to') => {
    const constraint = `trade_items_${route}_member_present`
    const column = `${route}_member_id`
    const notValid = source.indexOf(`${constraint} CHECK (${column} IS NOT NULL) NOT VALID`)
    const validate = source.indexOf(`VALIDATE CONSTRAINT ${constraint}`)
    const setNotNull = source.indexOf(`ALTER COLUMN ${column} SET NOT NULL`)
    return notValid >= 0 && validate > notValid && setNotNull > validate
}
const occurrences = (source: string, pattern: string) => source.split(pattern).length - 1
const canonicalAssetAssertionContract = (source: string) => {
    const helperStart = source.indexOf('CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready')
    const triggerStart = source.indexOf('CREATE OR REPLACE FUNCTION private.prevent_conflicting_or_inactive_trade_accept')
    const acceptStart = source.indexOf('CREATE OR REPLACE FUNCTION private.accept_trade_participant_atomic')
    if (helperStart < 0 || triggerStart <= helperStart || acceptStart <= triggerStart) return false
    const helper = source.slice(helperStart, triggerStart)
    return helper.includes('roster.is_on_ir = false') &&
        helper.includes('roster.is_on_taxi = false') &&
        occurrences(helper, 'pick.current_owner_id = item.from_member_id') === 2 &&
        occurrences(helper, 'pick.is_used = false') === 2 &&
        helper.includes('accepted_item.pick_id = item.pick_id') &&
        helper.includes('accepted_trade.status = \'accepted\'::trade_status')
}
const canonicalAssetTriggerContract = (source: string) => source.includes(
    'CREATE OR REPLACE FUNCTION private.prevent_conflicting_or_inactive_trade_accept()',
) && source.includes('SECURITY DEFINER') && source.includes(
    'private.assert_trade_assets_acceptance_ready(\n      NEW.id,',
)
const pushTokenCredentialUpgradeContract = (source: string) => {
    const addHash = source.indexOf('ADD COLUMN push_token_revocation_hash text')
    const compatibilityTrigger = source.indexOf('CREATE TRIGGER normalize_legacy_push_token_write')
    const credentialBackfill = source.indexOf('SET push_token_revocation_hash = encode(extensions.gen_random_bytes(32)')
    const uniqueIndex = source.indexOf('CREATE UNIQUE INDEX profiles_push_token_unique')
    const pairConstraint = source.indexOf('ADD CONSTRAINT profiles_push_token_revocation_pair')
    return addHash >= 0 && compatibilityTrigger > addHash && credentialBackfill > compatibilityTrigger &&
        uniqueIndex > credentialBackfill && pairConstraint > uniqueIndex &&
        !source.includes('SET push_token = NULL\n WHERE push_token IS NOT NULL')
}

describe('branch migration deployment safety', () => {
    it('bounds every lock-taking migration in the unpublished 20260709 series', () => {
        const migrations = readdirSync(migrationsDirectory)
            .filter((filename) => filename.endsWith('.sql') && filename.startsWith('20260709'))
            .filter((filename) => lockTakingStatements(read(filename)).length > 0)

        expect(migrations).not.toEqual([])
        for (const migration of migrations) expect(bounded(read(migration)), migration).toBe(true)

        const mutation = read('20260709100027_sleeper_lazy_roster_limits.sql')
            .replace('RESET statement_timeout;', '')
            .replace('RESET lock_timeout;', '')
            .replace(
                "SET statement_timeout = '2min';",
                "SET statement_timeout = '2min';\nRESET statement_timeout;\nRESET lock_timeout;",
            )
        expect(bounded(mutation)).toBe(false)

        for (const migration of [
            '20260709100001_waiver_submission_policy_and_index.sql',
            '20260709100019_catalog_and_lifecycle_guards.sql',
            '20260709100022_trade_query_invoker_auth.sql',
        ]) {
            expect(bounded(read(migration).replace("SET lock_timeout = '5s';", '')), migration).toBe(false)
        }
    })

    it.each([
        'DROP FUNCTION public.example()',
        'INSERT INTO public.example (id) VALUES (1)',
        'UPDATE example SET id = 2',
        'DELETE FROM example WHERE id = 2',
    ])('recognizes top-level %s without matching function-body DML', (statement) => {
        expect(lockTakingStatements(`CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE hidden SET id = 1; END; $$;`)).toEqual([])
        expect(lockTakingStatements(statement)).toEqual([statement])
        expect(bounded(`SET lock_timeout = '5s'; SET statement_timeout = '1min'; ${statement}; RESET statement_timeout; RESET lock_timeout;`)).toBe(true)
    })

    it('preserves legacy push tokens through a paired-state compatibility trigger', () => {
        const migration = read('20260709100035_push_token_revocation_credentials.sql')
        expect(pushTokenCredentialUpgradeContract(migration)).toBe(true)
        expect(pushTokenCredentialUpgradeContract(
            migration.replace('CREATE TRIGGER normalize_legacy_push_token_write', 'CREATE TRIGGER removed_compatibility'),
        )).toBe(false)
    })

    it.each(['from', 'to'] as const)(
        'validates the %s route online before taking the short NOT NULL lock',
        (route) => {
            const migration = read('20260709100024_trade_route_and_feed_hardening.sql')
            expect(onlineRouteConstraintSequence(migration, route)).toBe(true)

            const constraint = `trade_items_${route}_member_present`
            const column = `${route}_member_id`
            const mutation = migration.replace(
                `${constraint} CHECK (${column} IS NOT NULL) NOT VALID`,
                `${constraint} CHECK (${column} IS NOT NULL)`,
            )
            expect(onlineRouteConstraintSequence(mutation, route)).toBe(false)
        },
    )

    it('records the canonical acceptance route and complete index cleanup additively', () => {
        const canonical = readFileSync(
            path.join(process.cwd(), 'supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql'),
            'utf8',
        )
        const additive = read('20260709100031_finalize_trade_route_and_index_ownership.sql')

        expect(canonical).toContain('private.assert_trade_assets_acceptance_ready')
        expect(canonical).not.toContain('accepted_item.player_id')
        expect(canonical).not.toContain('accepted_item.pick_id')
        expect(canonical).not.toContain('accepted_item.side')
        expect(additive).toContain('accepted_item.from_member_id = v_from_member')
        expect(additive).not.toContain('accepted_item.side')
        const assetAssertion = read('20260709100032_canonical_trade_asset_acceptance_assertion.sql')
        expect(assetAssertion).toContain('private.assert_trade_assets_acceptance_ready')
        expect(assetAssertion).not.toContain('FOR v_item IN')
        for (const index of [
            'idx_trades_league_proposer_recent',
            'idx_trades_league_recipient_recent',
            'idx_trades_member_proposed',
            'idx_trades_recipient_proposed',
            'idx_trades_vetoable_recent',
        ]) expect(additive).toContain(`DROP INDEX IF EXISTS public.${index};`)
    })

    it('mutation-proves every canonical asset assertion branch and direct trigger wiring', () => {
        const migration = read('20260709100032_canonical_trade_asset_acceptance_assertion.sql')
        const triggerMigration = read('20260709100033_secure_trade_asset_acceptance_trigger.sql')
        expect(canonicalAssetAssertionContract(migration)).toBe(true)
        expect(canonicalAssetTriggerContract(triggerMigration)).toBe(true)

        const mutations = [
            migration.replace('AND roster.is_on_ir = false', ''),
            migration.replace('AND roster.is_on_taxi = false', ''),
            migration.replaceAll('AND pick.current_owner_id = item.from_member_id', ''),
            migration.replaceAll('AND pick.is_used = false', ''),
            migration.replace('ON accepted_item.pick_id = item.pick_id', 'ON accepted_item.pick_id IS NOT NULL'),
        ]
        for (const mutation of mutations) expect(canonicalAssetAssertionContract(mutation)).toBe(false)
        for (const mutation of [
            triggerMigration.replace('SECURITY DEFINER', 'SECURITY INVOKER'),
            triggerMigration.replace('NEW.id,', 'OLD.id,'),
        ]) expect(canonicalAssetTriggerContract(mutation)).toBe(false)
    })
})
